"""End-to-end check of the P1 editing core, against a scratch copy of the mod.

    python test/e2e_edit.py

Starts its own dev server on :5179 with SVRE_MOD_DIR pointing at a temp copy of the
StoneValley room files, so nothing here can touch the real mod. Checks:

  * an unedited room serializes byte-identically (in the browser, through RoomDoc)
  * drag-move snaps to 26 px, undo/redo restore exactly, undo-all is byte-identical again
  * delete + undo, palette placement onto the active layer, game_objects mirror kept in sync
  * Ctrl+S writes exactly what serialize() says; an external change makes the save refuse (409)
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
CFG = json.loads((ROOT / "svre.config.json").read_text(encoding="utf-8"))
SRC_CODES = Path(CFG["modDir"]) / "Codes"
ROOM = "r_sv_hut_inside2.gml"
PORT = 5179

failures = []


def check(cond, what):
    print(("  ok   " if cond else "  FAIL ") + what)
    if not cond:
        failures.append(what)


def layer_ids(room):
    return sorted(i["instance_id"] for L in room["layers"] for i in L["layer_data"].get("instances", []))


def mirror_ok(room):
    by = {g["instance_id"]: g for g in room["game_objects"]}
    insts = [i for L in room["layers"] for i in L["layer_data"].get("instances", [])]
    return len(by) == len(insts) and all(by.get(i["instance_id"]) == i for i in insts)


def main():
    scratch = Path(tempfile.mkdtemp(prefix="svre-e2e-"))
    (scratch / "Codes").mkdir()
    for f in SRC_CODES.iterdir():
        if f.name.startswith("r_") and f.suffix == ".gml":
            shutil.copy2(f, scratch / "Codes" / f.name)
    target = scratch / "Codes" / ROOM
    original = target.read_bytes()

    env = {**os.environ, "SVRE_MOD_DIR": str(scratch)}
    server = subprocess.Popen("npx vite --port %d --strictPort" % PORT, cwd=ROOT, env=env, shell=True,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    try:
        for _ in range(120):
            try:
                urllib.request.urlopen(f"http://localhost:{PORT}/api/rooms", timeout=1)
                break
            except Exception:
                time.sleep(0.5)

        with sync_playwright() as p:
            b = p.chromium.launch()
            pg = b.new_page(viewport={"width": 1600, "height": 1000})
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.on("dialog", lambda d: d.dismiss())
            pg.goto(f"http://localhost:{PORT}/?room={ROOM}")
            pg.wait_for_function("document.getElementById('load-state').textContent.includes('可见')", timeout=60000)

            print("round trip")
            text = pg.evaluate("svre.serialize()")
            check(text.encode("utf-8") == original, "unedited room serializes byte-identically")

            print("drag-move with snap")
            pg.evaluate("svre.set('hidden', true); svre.set('collision', false); svre.focus(400, 330, 2)")
            box = pg.locator("#stage").bounding_box()
            s = pg.evaluate("svre.screen(300, 300)")
            sx, sy = box["x"] + s["x"], box["y"] + s["y"]
            pg.mouse.click(sx, sy)
            pg.wait_for_timeout(200)
            picked = pg.evaluate("svre.selection.map(i => ({x: i.x, y: i.y, o: i.object_definition}))")
            check(len(picked) == 1, f"click selects one instance ({picked})")
            target_inst = picked[0]
            before = json.loads(text)
            pg.mouse.move(sx, sy)
            pg.mouse.down()
            pg.mouse.move(sx + 30, sy + 5, steps=4)   # 15 world px right: rounds to 26 with snap
            pg.mouse.move(sx + 60, sy + 6, steps=4)   # 30 world px -> 26
            pg.mouse.up()
            pg.wait_for_timeout(300)
            sel = pg.evaluate("svre.selection.map(i => ({x: i.x, y: i.y, o: i.object_definition}))")
            check(len(sel) == 1, f"one instance selected after drag ({sel})")
            if sel:
                check(sel[0]["x"] - target_inst["x"] == 26 and sel[0]["y"] == target_inst["y"], f"moved by exactly (+26, 0): now {sel[0]['x']},{sel[0]['y']}")
            moved = json.loads(pg.evaluate("svre.serialize()"))
            check(mirror_ok(moved), "game_objects mirror still matches layer instances after move")

            pg.keyboard.press("Control+z")
            pg.wait_for_timeout(200)
            check(pg.evaluate("svre.serialize()").encode("utf-8") == original, "undo restores byte-identical file")
            pg.keyboard.press("Control+y")
            pg.wait_for_timeout(200)
            check(json.loads(pg.evaluate("svre.serialize()")) == moved, "redo reapplies the move")
            pg.keyboard.press("Control+z")
            pg.wait_for_timeout(200)

            print("delete + undo")
            pg.mouse.click(sx, sy)
            n_before = len(layer_ids(before))
            pg.keyboard.press("Delete")
            pg.wait_for_timeout(200)
            after_del = json.loads(pg.evaluate("svre.serialize()"))
            check(len(layer_ids(after_del)) == n_before - 1 and mirror_ok(after_del), "delete removes one instance from layer and mirror")
            pg.keyboard.press("Control+z")
            pg.wait_for_timeout(200)
            check(pg.evaluate("svre.serialize()").encode("utf-8") == original, "undo delete is byte-identical")
            check(pg.evaluate("svre.doc.dirty") is False, "document is clean after undoing everything")

            print("palette placement")
            pg.click(".tabs button[data-tab=palette]")
            pg.fill("#palette-q", "o_chest")
            pg.wait_for_timeout(300)
            first = pg.locator("#palette-list li[data-o]").first
            obj = first.get_attribute("data-o")
            first.click()
            active = pg.evaluate("svre.doc.room.layers.findIndex(L => document.querySelector('#layer-list li.active') && L.layer_name === document.querySelector('#layer-list li.active .name').textContent.trim())")
            ps = pg.evaluate("svre.screen(390, 400)")
            pg.mouse.click(box["x"] + ps["x"], box["y"] + ps["y"])
            pg.keyboard.press("Escape")
            pg.wait_for_timeout(300)
            placed = json.loads(pg.evaluate("svre.serialize()"))
            new = [i for L in placed["layers"] for i in L["layer_data"].get("instances", []) if i["object_definition"] == obj]
            check(len(new) >= 1, f"{obj} placed")
            if new:
                i = new[-1]
                check(i["x"] % 26 == 0 and i["y"] % 26 == 0, f"placed on a cell corner ({i['x']},{i['y']})")
                check(list(i.keys()) == list(before["layers"][0]["layer_data"].get("instances", [{}])[0].keys()) or list(i.keys()) == list(before["game_objects"][0].keys()),
                      "new instance has the exporter's key order")
            check(mirror_ok(placed), "placement mirrored into game_objects")

            print("save")
            pg.keyboard.press("Control+s")
            pg.wait_for_timeout(600)
            on_disk = target.read_bytes()
            check(on_disk.decode("utf-8") == pg.evaluate("svre.serialize()"), "Ctrl+S wrote exactly serialize()")
            check(pg.evaluate("svre.doc.dirty") is False, "clean after save")

            print("conflict guard")
            target.write_bytes(on_disk + b" ")  # someone else touches the file
            pg.keyboard.press("Delete")  # the placed chest is still selected
            pg.wait_for_timeout(200)
            pg.keyboard.press("Control+s")
            pg.wait_for_timeout(600)
            check(target.read_bytes() == on_disk + b" ", "save refused when the file changed on disk (409)")
            check(pg.evaluate("svre.doc.dirty") is True, "edits kept in the editor after a refused save")

            check(not errors, f"no page errors {errors}")
            b.close()
    finally:
        subprocess.run(f"taskkill /PID {server.pid} /T /F", shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shutil.rmtree(scratch, ignore_errors=True)

    print("\nFAILED: %d" % len(failures) if failures else "\nall passed")
    sys.exit(1 if failures else 0)


main()
