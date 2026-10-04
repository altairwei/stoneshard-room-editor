"""End-to-end check of the server-owned room document, against a scratch copy of the mod.

    python test/e2e_edit.py

Starts its own dev server on :5179 with SVRE_MOD_DIR pointing at a temp copy of the
StoneValley room files, so nothing here can touch the real mod. Two halves:

  A. pure HTTP (the agent path): import a compiled room into a project, byte-identical
     compile, apply/undo/redo with per-author history, stale-expect 409, notes,
     selection, changes, drift -> adopt -> compile.
  B. browser (the human path): drag-move lands in the server log, Ctrl+Z undoes it,
     an agent edit over HTTP shows up in the open page (websocket), palette placement,
     Ctrl+S compiles.
"""
import functools
import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import urllib.error
import zipfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
CFG = json.loads((ROOT / "svre.config.json").read_text(encoding="utf-8"))
ROOM = "r_sv_hut_inside2"
PORT = 5179
SETUP_PORT = 5181
SETUP_UI_PORT = 5183
SETUP_SCAN_PORT = 5185
SETUP_UTMT_PORT = 5187      # the wizard's own server (UTMT CLI download)
UTMT_ZIP_PORT = 5189        # stands in for the github.com release asset
PROJ_PORT = 5191            # the project model: welcome page, open/close/switch
SLOW_ZIP_PORT = 5193        # a download that never answers, to hold utmtState.running
BASE = f"http://localhost:{PORT}"

# Opening the palette rebuilds the whole object library (innerHTML + one thumbnail per
# object) on the renderer's main thread, so the round-trip behind this wait can take
# seconds even though the dialog is open by the time the click returns (measured ~3.5s
# idle; the full suite is heavier). The app is honest here -- only the timeout was tight.
PALETTE_WAIT = 30000

failures = []


def check(cond, what):
    print(("  ok   " if cond else "  FAIL ") + what)
    if not cond:
        failures.append(what)


def call(method, path, body=None, expect=200):
    req = urllib.request.Request(
        BASE + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"} if body is not None else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            raw = r.read().decode("utf-8")
            return r.status, json.loads(raw) if raw and r.headers.get("Content-Type", "").startswith("application/json") else raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, raw


def find_inst(doc, iid):
    for L in doc["room"]["layers"]:
        for i in L["layer_data"].get("instances", []):
            if i["instance_id"] == iid:
                return i
    return None


def mirror_ok(room):
    by = {g["instance_id"]: g for g in room["game_objects"]}
    insts = [i for L in room["layers"] for i in L["layer_data"].get("instances", [])]
    return len(by) == len(insts) and all(by.get(i["instance_id"]) == i for i in insts)


def main():
    scratch = Path(tempfile.mkdtemp(prefix="svre-e2e-"))
    (scratch / "Codes").mkdir()
    # the import source is a legacy Codes/r_*.gml room artifact; the golden fixture
    # stands in for one (the mod's own rooms live in rooms/*.compiled.json now)
    golden = (ROOT / "test" / "golden" / f"{ROOM}.json").read_bytes()
    (scratch / "Codes" / f"{ROOM}.gml").write_bytes(golden)
    # mod assets: the editor reads Sprites/*.png + the assets.json manifest (which it
    # also compiles to <Mod>.Assets.g.cs -- no C# parsing anywhere)
    shutil.copytree(Path(CFG["modDir"]) / "Sprites", scratch / "Sprites")
    shutil.copy2(Path(CFG["modDir"]) / "assets.json", scratch / "assets.json")
    target = scratch / "rooms" / f"{ROOM}.compiled.json"  # written by import, then by compile
    original = golden

    env = {**os.environ, "SVRE_MOD_DIR": str(scratch)}
    server = subprocess.Popen("npx vite --port %d --strictPort" % PORT, cwd=ROOT, env=env, shell=True,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    try:
        for _ in range(120):
            try:
                urllib.request.urlopen(f"{BASE}/api/rooms", timeout=1)
                break
            except Exception:
                time.sleep(0.5)

        print("A. HTTP / agent path")
        st, roomlist = call("GET", "/api/rooms")
        entry = next((r for r in roomlist if r["name"] == ROOM), None)
        check(st == 200 and entry is not None and not entry["hasProject"], f"{ROOM} listed, no project yet")

        st, r = call("POST", "/api/import", {"name": ROOM, "by": "test"})
        check(st == 200 and r.get("base"), f"import guessed the base room ({r})")

        st, doc = call("GET", f"/api/doc/{ROOM}")
        check(st == 200 and doc["rev"] == 1, "project opens at rev 1")
        check(mirror_ok(doc["room"]), "game_objects mirror matches layer instances")

        st, r = call("POST", f"/api/doc/{ROOM}/compile", {})
        check(st == 200 and target.read_bytes() == original, "compile of an untouched import is byte-identical")
        # read the generated C# as BYTES: the snapshots are CRLF-styled
        rcs = scratch / f"{scratch.name}.Rooms.g.cs"
        rcsraw = rcs.read_bytes() if rcs.exists() else b""
        m = re.search(rb'public const string ' + ROOM.encode() + rb' = ("{3,})\n(.*?)\n\1;', rcsraw, re.S)
        check(m is not None and m.group(2) == original
              and f"Msl.AddRoomJson({ROOM});".encode() in rcsraw, "Rooms.g.cs embeds the room byte-identically + registers it")

        # two instances to move, one per author
        insts = [i for L in doc["room"]["layers"] for i in L["layer_data"].get("instances", [])]
        a, b = insts[0], insts[1]
        ax, ay, bx, by = a["x"], a["y"], b["x"], b["y"]

        st, r = call("POST", f"/api/doc/{ROOM}/apply", {
            "by": "agent-test", "label": "移动 A",
            "ops": [{"op": "set", "id": a["instance_id"], "set": {"x": ax + 26, "y": ay}, "expect": {"x": ax, "y": ay}}]})
        check(st == 200 and r["ids"] == [a["instance_id"]], "agent apply moves A (rev %s)" % r.get("rev"))

        st, r = call("POST", f"/api/doc/{ROOM}/apply", {
            "by": "agent-test",
            "ops": [{"op": "set", "id": a["instance_id"], "set": {"x": ax}, "expect": {"x": ax + 999}}]})
        check(st == 409 and r.get("detail", {}).get("code") == "expect", "stale expect refused with 409")

        st, r = call("POST", f"/api/doc/{ROOM}/apply", {
            "by": "human", "label": "移动 B",
            "ops": [{"op": "set", "id": b["instance_id"], "set": {"x": bx, "y": by + 26}, "expect": {"x": bx, "y": by}}]})
        check(st == 200, "human apply moves B")

        st, r = call("POST", f"/api/doc/{ROOM}/undo", {"by": "agent-test"})
        st2, doc2 = call("GET", f"/api/doc/{ROOM}")
        ia, ib = find_inst(doc2, a["instance_id"]), find_inst(doc2, b["instance_id"])
        check(st == 200 and ia["x"] == ax and ib["y"] == by + 26, "undo is per-author: A reverted, B untouched")

        st, r = call("POST", f"/api/doc/{ROOM}/redo", {"by": "agent-test"})
        st2, doc2 = call("GET", f"/api/doc/{ROOM}")
        check(find_inst(doc2, a["instance_id"])["x"] == ax + 26, "redo re-applies the agent's move")

        st, ch = call("GET", f"/api/doc/{ROOM}/changes?since=1")
        check(st == 200 and len(ch["entries"]) >= 3 and ch["head"] == ch["entries"][-1]["rev"], "changes since rev 1 lists the log")

        print("A. z-order: same-layer relayer = reorder")
        st, docr = call("GET", f"/api/doc/{ROOM}")
        lay = next(L for L in docr["room"]["layers"] if L["layer_type"] == 2 and len(L["layer_data"].get("instances", [])) >= 3)
        arr = [i["instance_id"] for i in lay["layer_data"]["instances"]]
        victim, anchor = arr[0], arr[2]
        st, r = call("POST", f"/api/doc/{ROOM}/apply", {
            "by": "agent-test", "label": "提到前面",
            "ops": [{"op": "relayer", "id": victim, "layer": lay["layer_name"], "before": anchor,
                     "expect": {"layer": lay["layer_name"]}}]})
        st2, docr2 = call("GET", f"/api/doc/{ROOM}")
        arr2 = [i["instance_id"] for i in next(L for L in docr2["room"]["layers"] if L["layer_name"] == lay["layer_name"])["layer_data"]["instances"]]
        check(st == 200 and arr2.index(victim) == arr2.index(anchor) - 1, "same-layer relayer moves the instance just before its anchor")
        st, r = call("POST", f"/api/doc/{ROOM}/apply", {
            "by": "agent-test", "ops": [{"op": "relayer", "id": victim, "layer": lay["layer_name"], "before": victim}]})
        check(st == 409 and r.get("detail", {}).get("code") == "invalid", "self-anchor refused with 409")
        st, r = call("POST", f"/api/doc/{ROOM}/apply", {
            "by": "agent-test", "ops": [{"op": "relayer", "id": victim, "layer": lay["layer_name"], "before": 99999999}]})
        check(st == 409 and r.get("detail", {}).get("code") == "missing", "missing anchor refused with 409")
        st, r = call("POST", f"/api/doc/{ROOM}/undo", {"by": "agent-test"})
        st2, docr3 = call("GET", f"/api/doc/{ROOM}")
        arr3 = [i["instance_id"] for i in next(L for L in docr3["room"]["layers"] if L["layer_name"] == lay["layer_name"])["layer_data"]["instances"]]
        check(st == 200 and arr3 == arr, "undo restores the original order")

        st, note = call("POST", f"/api/doc/{ROOM}/notes", {"by": "agent-test", "x": 100, "y": 130, "text": "这里要放箱子"})
        st2, doc2 = call("GET", f"/api/doc/{ROOM}")
        check(st == 200 and any(n["text"] == "这里要放箱子" for n in doc2["notes"]), "note lands in the project")
        st, r = call("POST", f"/api/doc/{ROOM}/notes", {"remove": note["id"]})
        check(st == 200, "note removed")

        st, r = call("POST", f"/api/doc/{ROOM}/selection", {"by": "agent-test", "ids": [a["instance_id"]]})
        st2, sel = call("GET", f"/api/doc/{ROOM}/selection")
        check(a["instance_id"] in sel.get("agent-test", {}).get("ids", []), "selection round-trips")

        st, grid = call("GET", f"/api/doc/{ROOM}/grid")
        check(st == 200 and isinstance(grid, str) and len(grid) > 10, "grid returns the ASCII cell map")
        st, qr = call("GET", f"/api/doc/{ROOM}/query?id={a['instance_id']}")
        check(st == 200 and len(qr) == 1 and qr[0]["cell"] == [(ax + 26) // 26, ay // 26], "query by id returns the instance (at its moved cell)")
        st, lint = call("GET", f"/api/doc/{ROOM}/lint")
        check(st == 200 and isinstance(lint, list), f"lint returns findings ({len(lint)})")

        print("A. Codes/ resolution: leaf names, subdirectories, collisions")
        # MSL's ModFiles.GetCode("x.gml") resolves by LEAF FILE NAME across the whole
        # Codes/ tree, ignoring directories -- the mod's own Codes/README.md states it,
        # and StoneValley.cs calls GetCode("scr_sv_furniture_cells.gml") for a file that
        # lives in Codes/Furniture/. Server-side resolution used to be flat
        # (Codes/<name>.gml), so every creation code of any mod that organises its Codes/
        # into subdirectories silently resolved to nothing (StoneValley: 59 of 59 files).
        # This pins it, and pins the freshness: the index is rebuilt per request, the way
        # the modObjects block in store.ts already was.
        code_of = {}
        for L in doc["room"]["layers"]:
            for i in L["layer_data"].get("instances", []):
                for c in (i.get("creation_code"), i.get("pre_create_code")):
                    if c:
                        code_of.setdefault(c, i["instance_id"])
        codes = sorted(code_of)
        check(len(codes) == 3, f"the fixture has creation codes to resolve ({len(codes)})")

        def missing():
            _, f = call("GET", f"/api/doc/{ROOM}/lint")
            return sorted(x["ids"][0] for x in f if x["rule"] == "missing-code")

        # Two of the three are vanilla RoomCC codes that the decompiled source dump also
        # holds, so only the mod's own one is unresolvable to begin with -- and that is the
        # one that actually exercises Codes/ resolution.
        base = missing()
        check(len(base) == 1, f"only the mod's own code is unresolvable to start with ({base})")
        only = next(c for c in codes if code_of[c] == base[0])

        nested = scratch / "Codes" / "RoomCC"
        nested.mkdir()
        for c in codes:
            (nested / f"{c}.gml").write_text("// nested, the way the mod organises them\n", encoding="utf-8")
        check(missing() == [], f"a subdirectory of Codes/ resolves it (still missing: {missing()})")

        (nested / f"{only}.gml").unlink()
        check(missing() == base, f"deleting the nested file brings its missing-code back, no restart ({missing()})")
        (nested / f"{only}.gml").write_text("// restored\n", encoding="utf-8")
        check(missing() == [], "restoring it clears the finding again")

        # two directories, one leaf name: MSL's GetCode takes whichever it finds first,
        # which is not something a room can rely on. Reported once, project-wide, with the
        # editor's own deterministic pick (shallowest, then path order) named.
        deep = nested / "deep"
        deep.mkdir()
        (deep / f"{only}.gml").write_text("// a second file with the same leaf name\n", encoding="utf-8")
        st, diag = call("GET", "/api/diagnostics")
        check(st == 200 and isinstance(diag.get("rooms"), list) and isinstance(diag.get("project"), list),
              "diagnostics returns rooms[] + project[]")
        dup = [p for p in diag["project"] if p["code"] == "codes-duplicate"]
        check(len(dup) == 1 and dup[0]["subject"] == f"{only}.gml", f"leaf collision reported once, project-wide ({dup})")
        check(dup and dup[0]["paths"] == [f"Codes/RoomCC/{only}.gml", f"Codes/RoomCC/deep/{only}.gml"],
              f"the winner is listed first (shallowest path wins): {dup[0]['paths'] if dup else None}")
        # the project-wide totals are the only count the panel trusts, so they must be the
        # sum of what it is about to render
        counted = {"error": 0, "warn": 0, "info": 0}
        for r in diag["rooms"]:
            for f_ in r["findings"]:
                counted[f_["level"]] += 1
        for p_ in diag["project"]:
            counted[p_["level"]] += 1
        check(diag["totals"] == counted, f"totals are the sum of the rows ({diag['totals']} vs {counted})")
        check(any(r["name"] == ROOM for r in diag["rooms"]), "the open room is in the project-wide list")
        st, one = call("GET", f"/api/doc/{ROOM}/lint")
        got = next((r for r in diag["rooms"] if r["name"] == ROOM), {}).get("findings", [])
        check(json.dumps(got, sort_keys=True) == json.dumps(one, sort_keys=True),
              "diagnostics agrees with the per-room lint, finding for finding")
        (deep / f"{only}.gml").unlink()
        deep.rmdir()

        print("A. vanilla read-only doc")
        st, vdoc = call("GET", "/api/vanilla-doc/r_Osbrook")
        check(st == 200 and vdoc.get("vanilla") is True and vdoc["room"]["name"] == "r_Osbrook", "vanilla doc opens straight from the cache")
        check(vdoc["log"] == [] and vdoc["notes"] == [] and vdoc["dirty"] is False and vdoc["rev"] == 0, "no project state rides along")
        check(mirror_ok(vdoc["room"]), "vanilla room's game_objects mirror matches")
        vinsts = [i for L in vdoc["room"]["layers"] for i in L["layer_data"].get("instances", [])]
        check(len(vinsts) > 1000, f"vanilla room fully populated ({len(vinsts)} instances)")
        st, _ = call("GET", "/api/vanilla-doc/r_definitely_not_a_room")
        check(st == 404, "unknown vanilla room 404s")

        print("A. drift / adopt")
        clean = target.read_bytes()
        target.write_bytes(clean + b" ")  # someone touches the compiled file
        st, doc3 = call("GET", f"/api/doc/{ROOM}")
        check(doc3["drift"] is True, "drift detected")
        st, r = call("POST", f"/api/doc/{ROOM}/compile", {})
        check(st == 409, "compile refuses while drifted")
        st, r = call("POST", f"/api/doc/{ROOM}/adopt", {})
        check(st == 200, f"adopt ok ({r})")
        st, r = call("POST", f"/api/doc/{ROOM}/compile", {})
        check(st == 200 and target.read_bytes() == clean, "compile after adopt writes exactly the adopted bytes")

        # adopt already reverted both moves (they conflicted with the adopted bytes), so
        # the room is back to the original and a compile proves it byte for byte
        st, r = call("POST", f"/api/doc/{ROOM}/compile", {})
        check(st == 200 and target.read_bytes() == original, "post-adopt compile restores the original bytes")

        print("A. mod asset import (sprite registration)")
        import base64
        import zlib
        import struct

        def png_bytes(w, h, rgba):
            def chunk(tag, data):
                c = tag + data
                return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
            raw = b"".join(b"\x00" + bytes(rgba) * w for _ in range(h))
            return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
                    + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))

        f0 = base64.b64encode(png_bytes(8, 8, (200, 120, 40, 255))).decode()
        f1 = base64.b64encode(png_bytes(8, 8, (40, 120, 200, 255))).decode()
        st, r = call("POST", "/api/mod-assets/import-sprite", {
            "sprite": "s_e2e_chair", "object": "o_e2e_chair", "parent": "o_shelf",
            "origin": [1, 2], "note": "e2e 测试件", "by": "agent-test",
            "frames": [{"data": f0}, {"data": f1}]})
        check(st == 200 and r.get("files") == ["s_e2e_chair_0.png", "s_e2e_chair_1.png"], f"import wrote two frames ({r})")
        check((scratch / "Sprites" / "s_e2e_chair_0.png").read_bytes() == base64.b64decode(f0), "frame bytes landed in Sprites/")
        man = json.loads((scratch / "assets.json").read_text(encoding="utf-8"))
        check(man["objects"].get("o_e2e_chair") == {"sprite": "s_e2e_chair", "parent": "o_shelf", "visible": True, "note": "e2e 测试件"},
              f"manifest object entry ({man['objects'].get('o_e2e_chair')})")
        check(man["sprites"].get("s_e2e_chair") == {"origin": [1, 2]}, "manifest sprite origin entry")
        acs = (scratch / f"{scratch.name}.Assets.g.cs").read_text(encoding="utf-8")
        check("o_e2e_chair" in acs and "OriginX = 1" in acs, "Assets.g.cs self-healed with the new registration")
        st, ma = call("GET", "/api/mod-assets")
        check(len(ma["sprites"]["s_e2e_chair"]["frames"]) == 2 and ma["objects"]["o_e2e_chair"]["parent"] == "o_shelf",
              "scan serves the new sprite (2 frames)")
        st, r = call("POST", "/api/mod-assets/import-sprite", {"sprite": "s_e2e_chair", "object": "o_e2e_other", "frames": [{"data": f0}]})
        check(st == 409, "re-importing an existing sprite refused with 409")
        st, r = call("POST", "/api/mod-assets/import-sprite", {"sprite": "s_house01", "object": "o_e2e_other", "frames": [{"data": f0}]})
        check(st == 409, "vanilla sprite name collision refused with 409")
        st, r = call("POST", "/api/mod-assets/import-sprite", {"sprite": "s_e2e_bad", "object": "o_bench", "frames": [{"data": f0}]})
        check(st == 409, "vanilla object name collision refused with 409")
        st, r = call("POST", "/api/mod-assets/import-sprite", {"sprite": "s bad", "object": "o_e2e_x", "frames": [{"data": f0}]})
        check(st == 400, "illegal sprite name refused with 400")
        st, r = call("POST", "/api/mod-assets/import-sprite", {"sprite": "s_e2e_x", "object": "o_e2e_x", "frames": []})
        check(st == 400, "zero frames refused with 400")
        st, r = call("POST", "/api/mod-assets/import-sprite", {"sprite": "s_e2e_x", "object": "o_e2e_x",
                                                               "frames": [{"data": base64.b64encode(b"not a png").decode()}]})
        check(st == 400, "non-PNG refused with 400")
        st, r = call("POST", "/api/mod-assets/import-sprite", {"sprite": "s_e2e_x", "object": "o_e2e_x", "parent": "o_nope",
                                                               "frames": [{"data": f0}]})
        check(st == 400, "unknown parent refused with 400")

        print("B. browser / human path")
        with sync_playwright() as p:
            browser = p.chromium.launch()
            pg = browser.new_page(viewport={"width": 1600, "height": 1000})
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.on("dialog", lambda d: d.dismiss())
            pg.goto(f"{BASE}/?room={ROOM}")
            pg.wait_for_function("document.getElementById('load-state').textContent.includes('可见')", timeout=60000)

            print("drag-move goes through the server")
            pg.evaluate("svre.set('collision', false)")
            # drag an ON-GRID drawn instance: the landing snap absorbs any off-grid
            # origin (the player sits at y=273, a half cell -- dragging it anywhere
            # would snap y to a corner), which would break the (+26, 0) expectation.
            # The wall/fence overlays at (260,208) are grid-aligned and pickable.
            pg.evaluate("svre.focus(364, 260, 2)")
            pg.wait_for_timeout(150)
            tid = None
            for cand in (117541, 117542):
                pt = pg.evaluate(f"svre.pickPoint({cand})")
                if pt:
                    tid = cand
                    break
            check(tid is not None, "an on-grid drawn instance is clickable")
            box = pg.locator("#stage").bounding_box()
            sx, sy = box["x"] + pt["x"], box["y"] + pt["y"]
            pg.mouse.click(sx, sy)
            pg.wait_for_timeout(200)
            sel = pg.evaluate("svre.selection")
            check(len(sel) == 1 and sel[0] == tid, f"click selects the on-grid instance ({sel})")
            src = next(i for L in json.loads(original)["layers"] for i in L["layer_data"].get("instances", []) if i["instance_id"] == tid)
            pg.mouse.move(sx, sy)
            pg.mouse.down()
            pg.mouse.move(sx + 30, sy + 6, steps=4)
            pg.mouse.move(sx + 60, sy + 6, steps=4)
            pg.mouse.up()
            pg.wait_for_timeout(500)
            st, doc4 = call("GET", f"/api/doc/{ROOM}")
            last = doc4["log"][-1]
            mi = find_inst(doc4, tid)
            check(last["by"] == "human" and "移动" in last["label"], f"drag logged as a human entry ({last['label']})")
            check(mi["x"] - src["x"] == 26 and mi["y"] == src["y"], f"server state moved by (+26, 0): now {mi['x']},{mi['y']}")
            check(pg.evaluate("svre.selection") == [tid], "the moved instance stays selected")

            pg.keyboard.press("Control+z")
            pg.wait_for_timeout(500)
            st, doc5 = call("GET", f"/api/doc/{ROOM}")
            check(find_inst(doc5, tid)["x"] == src["x"], "Ctrl+Z undid the drag on the server")

            print("bottom panel: the project's problems, and the events this page received")
            # the answer to "app 显示有 6 条警告，我去哪看": the count lives on the status
            # bar (the top bar's own copy was merged away with the appbar), and the panel
            # behind it is the whole project, not just the open room
            check(pg.eval_on_selector("#bottom-panel", "e => e.hidden"), "the panel starts closed")
            pg.wait_for_selector("#s-problems:not([hidden])", timeout=15000)
            check("⚠" in pg.inner_text("#s-problems"), f"the status bar carries the count ({pg.inner_text('#s-problems')!r})")
            pg.click("#s-problems")
            check(not pg.eval_on_selector("#bottom-panel", "e => e.hidden"), "clicking the status-bar count opens the panel")
            check(pg.eval_on_selector("#bpt-problems", "e => !e.hidden"), "it opens on 问题")
            pg.keyboard.press("Control+Shift+KeyM")
            check(pg.eval_on_selector("#bottom-panel", "e => e.hidden"), "Ctrl+Shift+M toggles it closed")
            pg.keyboard.press("Control+Shift+KeyM")
            check(pg.eval_on_selector("#bpt-problems", "e => !e.hidden"), "and back open, still on 问题")

            # guarantee a row to look at, and prove the list is live rather than a snapshot
            # taken at load: take one nested creation code away, then ask for a re-check
            gone = nested / f"{only}.gml"
            body = gone.read_bytes()
            gone.unlink()
            pg.click("#bp-refresh")
            for _ in range(40):
                if "missing-code" in " ".join(pg.eval_on_selector_all("#problems-list .p-rule", "els => els.map(e => e.textContent)")):
                    break
                pg.wait_for_timeout(250)
            rows = pg.eval_on_selector_all("#problems-list li.p-row", "els => els.map(e => e.textContent)")
            check(any("missing-code" in r for r in rows), f"重新检查 picked up a finding that appeared after load ({len(rows)} rows)")
            check(code_of[only] in pg.eval_on_selector_all("#problems-list li.p-row.jump", "els => els.map(e => +e.dataset.ids.split(',')[0])"),
                  "the row carries the instance id it is about")
            gone.write_bytes(body)  # put it back before anything else runs

            # the log holds what this page received: the drag and the undo above are in it,
            # but our own cursor moving is not (that would be 90% of the lines)
            pg.click('.bp-tabs button[data-bptab="log"]')
            log = pg.eval_on_selector("#log-list", "e => e.textContent")
            check("移动" in log, f"the drag is in the event log ({log[:100]!r})")
            check("你选中了" not in log, "our own selection chatter is not")

            pg.click("#bp-close")
            check(pg.eval_on_selector("#bottom-panel", "e => e.hidden"), "the × closes it")

            print("drag-resize a coverage rectangle")
            pg.evaluate("svre.set('collision', true)")
            t = pg.evaluate("svre.pickRect()")
            check(t is not None, "pickRect found a coverage rectangle")
            if t:
                srcr = find_inst(doc5, t["id"])
                pg.evaluate(f"svre.focus({srcr['x']}, {srcr['y']}, 2)")
                pg.wait_for_timeout(200)
                t = pg.evaluate("svre.pickRect()")  # handle points after the refocus
                box = pg.locator("#stage").bounding_box()
                pg.mouse.click(box["x"] + t["bounds"]["x"] + t["bounds"]["w"] / 2, box["y"] + t["bounds"]["y"] + t["bounds"]["h"] / 2)
                pg.wait_for_timeout(250)
                sel = pg.evaluate("svre.selection")
                check(len(sel) == 1, f"click selects one instance ({sel})")
                check(pg.evaluate(f"svre.gateOf({sel[0]})") is True, f"selected #{sel[0]} offers resize handles")
                hp = pg.evaluate(f"svre.handlePoint({sel[0]}, 'e')")
                check(hp is not None, "east handle exists")
                g = pg.evaluate(f"svre.geom({sel[0]})")
                obj_w = g["lb"]["w"]
                left0, right0 = g["box"]["x"], g["box"]["x"] + g["box"]["w"]
                hx, hy = box["x"] + hp["x"], box["y"] + hp["y"]
                pg.mouse.move(hx, hy)
                pg.mouse.down()
                pg.mouse.move(hx + 30, hy, steps=4)
                pg.mouse.move(hx + 60, hy, steps=4)  # zoom 2 -> +30 world px -> snaps to +26
                pg.mouse.up()
                pg.wait_for_timeout(500)
                st, doc6 = call("GET", f"/api/doc/{ROOM}")
                mir = find_inst(doc6, sel[0])
                last = doc6["log"][-1]
                check(last["by"] == "human" and "调整" in last["label"], f"resize logged as a human entry ({last['label']!r})")
                check(mir["y"] == srcr["y"] and mir["scale_y"] == srcr["scale_y"], "resize leaves y/scale_y alone")
                check(abs(mir["x"] - srcr["x"]) <= 26, "x shifts as the origin settles on a grid corner (centred sprites)")
                # snap quantizes the driven axis to a whole number of cells -- the game
                # draws these rectangles as integer scale_x/scale_y
                u = int((right0 + 30 - left0) / obj_w + 0.5)
                grew = (mir["scale_x"] - srcr["scale_x"]) * obj_w
                check(mir["scale_x"] == int(mir["scale_x"]), f"scale stays an integer cell count ({mir['scale_x']})")
                check(grew == (u - srcr["scale_x"]) * obj_w and u > srcr["scale_x"],
                      f"east drag grew the box by whole cells ({grew}px)")
                pg.keyboard.press("Control+z")
                pg.wait_for_timeout(500)
                st, doc7 = call("GET", f"/api/doc/{ROOM}")
                check(find_inst(doc7, sel[0])["scale_x"] == srcr["scale_x"], "Ctrl+Z undid the resize on the server")

            print("resize snaps whatever the sprite frame")
            # s_gray is 5x5 -- a frame that is not a multiple of 26. The game draws these
            # rectangles as whole 26px cells: scale_x/scale_y are cell counts and stay
            # integers in every vanilla room. So snap quantizes the driven axis to a whole
            # number of cells and settles the origin on the nearest grid corner; Alt frees it
            st, r = call("POST", f"/api/doc/{ROOM}/apply", {
                "by": "agent-test", "label": "放个非整格盒子",
                "ops": [{"op": "add", "layer": "ForegroundInstances",
                         "inst": {"object_definition": "o_speech_trigger", "x": 52, "y": 52,
                                  "scale_x": 5.2, "scale_y": 5.2}}]})
            gid = r["ids"][0] if st == 200 else None
            check(gid is not None, "added a non-cell coverage rectangle (o_speech_trigger, 5x5 frame)")
            if gid:
                # select via the insts-tab row: a canvas click would hit the wall-sized
                # collision stamps (overlay zIndex above hidden objects) instead
                try:
                    pg.wait_for_selector(f"#inst-list li.inst[data-id='{gid}']", timeout=10000)
                    pg.click(f"#inst-list li.inst[data-id='{gid}']")
                    pg.wait_for_function(f"svre.gateOf({gid}) === true", timeout=10000)
                    g0 = pg.evaluate(f"svre.geom({gid})")
                except Exception:
                    g0 = None
                check(pg.evaluate("svre.selection") == [gid], "row click selects the non-cell box")
                check(g0 is not None, "it offers resize handles")
                if g0:
                    cx, cy = g0["box"]["x"] + g0["box"]["w"] / 2, g0["box"]["y"] + g0["box"]["h"] / 2
                    pg.evaluate(f"svre.focus({cx}, {cy}, 2)")
                    pg.wait_for_timeout(250)
                    box = pg.locator("#stage").bounding_box()
                    hp = pg.evaluate(f"svre.handlePoint({gid}, 'e')")
                    right0 = g0["box"]["x"] + g0["box"]["w"]
                    if hp:
                        pg.mouse.move(box["x"] + hp["x"], box["y"] + hp["y"])
                        pg.mouse.down()
                        pg.mouse.move(box["x"] + hp["x"] + 60, box["y"] + hp["y"], steps=5)  # +30 world px at zoom 2
                        pg.mouse.up()
                        pg.wait_for_timeout(600)
                        st, dd = call("GET", f"/api/doc/{ROOM}")
                        mir = find_inst(dd, gid)
                        check(mir["scale_x"] == int(mir["scale_x"]) and mir["scale_x"] > 5.2 and mir["x"] % 26 == 0,
                              f"snap on: whole-cell scale on a grid-corner origin (scale {mir['scale_x']}, x {mir['x']})")
                        pg.keyboard.press("Control+z")
                        pg.wait_for_timeout(500)
                        pg.keyboard.down("Alt")
                        pg.mouse.move(box["x"] + hp["x"], box["y"] + hp["y"])
                        pg.mouse.down()
                        pg.mouse.move(box["x"] + hp["x"] + 60, box["y"] + hp["y"], steps=5)
                        pg.mouse.up()
                        pg.keyboard.up("Alt")
                        pg.wait_for_timeout(600)
                        st, dd = call("GET", f"/api/doc/{ROOM}")
                        mir = find_inst(dd, gid)
                        west = mir["x"] + mir["scale_x"] * g0["lb"]["x"]
                        edge = west + mir["scale_x"] * g0["lb"]["w"]
                        check(abs(edge - int(right0 + 30 + 0.5)) < 1, f"Alt frees the edge to the raw pixel ({edge})")
                        pg.keyboard.press("Control+z")
                        pg.wait_for_timeout(500)
                        # an off-grid start: snap absorbs the deviation too -- the origin
                        # settles on the nearest grid corner and the scale stays whole
                        st, r = call("POST", f"/api/doc/{ROOM}/apply", {
                            "by": "agent-test",
                            "ops": [{"op": "set", "id": gid, "set": {"x": 55, "y": 57}, "expect": {"x": 52, "y": 52}}]})
                        check(st == 200, "box pushed off the grid (55,57)")
                        try:
                            pg.wait_for_function(
                                f"(() => {{ const r = svre.doc.room; for (const L of r.layers) for (const i of (L.layer_data.instances ?? [])) if (i.instance_id === {gid}) return i.x === 55; return false; }})()",
                                timeout=8000)
                            hp2 = pg.evaluate(f"svre.handlePoint({gid}, 'e')")
                        except Exception:
                            hp2 = None
                        check(hp2 is not None, "off-grid box still offers the east handle")
                        if hp2:
                            pg.mouse.move(box["x"] + hp2["x"], box["y"] + hp2["y"])
                            pg.mouse.down()
                            pg.mouse.move(box["x"] + hp2["x"] + 60, box["y"] + hp2["y"], steps=5)
                            pg.mouse.up()
                            pg.wait_for_timeout(600)
                            st, dd = call("GET", f"/api/doc/{ROOM}")
                            mir = find_inst(dd, gid)
                            check(mir["scale_x"] == int(mir["scale_x"]) and mir["x"] % 26 == 0,
                                  f"resize absorbed the deviation: integer scale, grid-corner origin (scale {mir['scale_x']}, x {mir['x']})")
                            pg.keyboard.press("Control+z")
                            pg.wait_for_timeout(500)
                        pg.keyboard.press("Escape")
                st, r = call("POST", f"/api/doc/{ROOM}/apply", {
                    "by": "agent-test",
                    "ops": [{"op": "delete", "id": gid, "expect": {"object_definition": "o_speech_trigger"}}]})
                check(st == 200, "non-cell box removed again")
                pg.evaluate("svre.focus(364, 338, 2)")  # back over the room for the later fixed-coordinate steps
                pg.wait_for_timeout(200)

            print("move snaps the landing spot, not the delta")
            # an instance that starts off the grid must land exactly on a cell corner
            # when snap is on (the old delta-snap carried the initial deviation along).
            # the canvas pick ranks collision/hidden overlays above drawn art, and two
            # giant o_hut_wall stamps (270x702 each) plus the wood surfaces blanket every
            # 66x71 chest-sized spot in this room -- so hide the overlay GM layers via the
            # 层组 eyes (editor-local, what a user does to work under the clutter) first
            st, dl = call("GET", f"/api/doc/{ROOM}")
            layers0 = dl["room"]["layers"]
            coll_idx = next(i for i, L in enumerate(layers0)
                            if any(j["object_definition"] == "o_hut_wall" for j in L["layer_data"].get("instances", [])))
            hide_idx = [i for i, L in enumerate(layers0) if L["layer_name"] in ("StaticCamera", "Controllers", "Surfaces")]
            hide_idx.append(coll_idx)
            pg.click(".tabs button[data-tab=layers]")
            for li in hide_idx:
                pg.click(f"#layer-list .eye[data-eye='{li}']")
            pg.wait_for_timeout(300)
            vis_overlays = pg.evaluate("(() => { let n = 0; for (const L of svre.doc.room.layers) for (const i of (L.layer_data.instances ?? [])) if (svre.kindOf(i.instance_id) !== 'drawn' && svre.visOf(i.instance_id)) n++; return n; })()")
            check(vis_overlays <= 2, f"hiding 层组 leaves at most the foreground ladder overlay ({vis_overlays} visible)")
            st, r = call("POST", f"/api/doc/{ROOM}/apply", {
                "by": "agent-test", "label": "放个没对齐的箱子",
                "ops": [{"op": "add", "layer": "ForegroundInstances",
                         "inst": {"object_definition": "o_chest", "x": 391, "y": 402}}]})
            mid = r["ids"][0] if st == 200 else None
            check(mid is not None, "added an off-grid instance (391,402)")
            if mid:
                cur = (391, 402)
                spawn = None
                for cx, cy in [(18, 14), (19, 15), (20, 16), (21, 13), (18, 18), (20, 20),
                               (22, 22), (16, 20), (14, 20), (12, 20), (12, 12), (22, 12)]:
                    sx, sy = cx * 26 + 3, cy * 26 + 2
                    st, r = call("POST", f"/api/doc/{ROOM}/apply", {
                        "by": "agent-test",
                        "ops": [{"op": "set", "id": mid, "set": {"x": sx, "y": sy},
                                 "expect": {"x": cur[0], "y": cur[1]}}]})
                    if st != 200:
                        continue
                    cur = (sx, sy)
                    try:
                        pg.wait_for_function(
                            f"(() => {{ const r = svre.doc.room; for (const L of r.layers) for (const i of (L.layer_data.instances ?? [])) if (i.instance_id === {mid}) return i.x === {sx} && i.y === {sy}; return false; }})()",
                            timeout=8000)
                    except Exception:
                        continue
                    if pg.evaluate(f"svre.pickPoint({mid})"):
                        spawn = (cx, cy)
                        break
                check(spawn is not None, f"found a grabbable spawn cell (at {spawn})")
                if spawn:
                    cx, cy = spawn
                    sx, sy = cx * 26 + 3, cy * 26 + 2
                    pg.evaluate(f"svre.focus({sx + 13}, {sy + 13}, 2)")
                    pg.wait_for_timeout(250)
                    gp = pg.evaluate(f"svre.pickPoint({mid})")
                    box = pg.locator("#stage").bounding_box()
                    grabbed = None
                    if gp:
                        gx, gy = box["x"] + gp["x"], box["y"] + gp["y"]
                        pg.mouse.move(gx, gy)
                        pg.mouse.down()
                        if pg.evaluate("svre.selection") == [mid]:
                            grabbed = (gx, gy)
                        else:
                            pg.mouse.up()
                            pg.keyboard.press("Escape")
                    check(grabbed is not None, "the drag grabbed the chest")
                    if grabbed:
                        ex, ey = (cx + 1) * 26, cy * 26
                        pg.mouse.move(grabbed[0] + 30, grabbed[1] + 3, steps=3)
                        pg.mouse.move(grabbed[0] + 60, grabbed[1] + 6, steps=3)  # +30,+3 world px at zoom 2
                        pg.mouse.up()
                        pg.wait_for_timeout(600)
                        st, dd = call("GET", f"/api/doc/{ROOM}")
                        mir = find_inst(dd, mid)
                        check(mir["x"] == ex and mir["y"] == ey,
                              f"off-grid start snapped to the nearest cell corner ({mir['x']},{mir['y']} -> {ex},{ey})")
                        pg.keyboard.press("Control+z")
                        pg.wait_for_timeout(500)
                st, r = call("POST", f"/api/doc/{ROOM}/apply", {
                    "by": "agent-test",
                    "ops": [{"op": "delete", "id": mid, "expect": {"object_definition": "o_chest"}}]})
                check(st == 200, "off-grid instance removed again")
                for li in hide_idx:
                    pg.click(f"#layer-list .eye[data-eye='{li}']")
                pg.wait_for_timeout(200)
                pg.evaluate("svre.focus(364, 338, 2)")
                pg.wait_for_timeout(200)

            art = pg.evaluate("svre.pickTarget()")
            if art:
                check(pg.evaluate(f"svre.gateOf({art['id']})") is not True, "drawn art gets no resize handles")

            print("agent edit reaches the open page")
            call("POST", f"/api/doc/{ROOM}/apply", {
                "by": "agent-test", "label": "从 HTTP 挪一下",
                "ops": [{"op": "set", "id": tid, "set": {"y": src["y"] + 52}, "expect": {"y": src["y"]}}]})
            pg.wait_for_timeout(800)
            got = pg.evaluate(f"(() => {{ const r = svre.doc.room; for (const L of r.layers) for (const i of (L.layer_data.instances ?? [])) if (i.instance_id === {tid}) return i.y; }})()")
            check(got == src["y"] + 52, f"websocket change refetched the doc (y={got})")

            print("mod assets in the editor")
            sp = pg.evaluate("svre.spriteOf('s_sv_house01')")
            check(sp == {"w": 442, "h": 312, "ox": 0, "oy": 234, "frames": 2}, f"mod sprite def incl. the manifest origin override ({sp})")
            # placement goes to the active layer, and clicking the canvas sets that to
            # whatever was hit (the prelude's drag can leave it on the in-game-hidden
            # Colissions) -- so pick a visible instances layer first, like a human would
            pg.click(".tabs button[data-tab=layers]")
            pg.locator("#layer-list li", has_text="ForegroundInstances").first.click()
            pg.click("#toolbox button[data-tool=place]")
            pg.wait_for_selector("#palette-dialog[open]", timeout=PALETTE_WAIT)
            pg.fill("#palette-q", "o_sv_house01")
            # renderPalette is debounced (80ms) off the input event; wait for the list to
            # actually reflect the query rather than guessing how long that takes
            try:
                pg.wait_for_function("document.querySelector('#palette-list li[data-o]')?.dataset.o === 'o_sv_house01'", timeout=5000)
                listed = True
            except Exception:
                listed = False
            first = pg.locator("#palette-list li[data-o]").first
            check(listed and first.get_attribute("data-o") == "o_sv_house01",
                  f"mod object appears in the palette (first={first.get_attribute('data-o')}, q={pg.eval_on_selector('#palette-q', 'el => el.value')!r})")
            first.click()
            ps = pg.evaluate("svre.screen(390, 400)")
            box = pg.locator("#stage").bounding_box()
            pg.mouse.click(box["x"] + ps["x"], box["y"] + ps["y"])
            pg.keyboard.press("Escape")
            # placement is a chain of async stages (HTTP commit -> server log -> WS refetch
            # -> scene rebuild, plus the first load of the mod PNG texture), so wait for
            # each stage instead of guessing one timeout
            hid = None
            hlayer = None
            for _ in range(40):
                st, d = call("GET", f"/api/doc/{ROOM}")
                news = [(L, i) for L in d["room"]["layers"] for i in L["layer_data"].get("instances", [])
                        if i["object_definition"] == "o_sv_house01"]
                if news:
                    hlayer, hi = max(news, key=lambda p: p[1]["instance_id"])
                    hid = hi["instance_id"]
                    break
                time.sleep(0.25)
            check(hid is not None, "placement commit landed in the server log")
            check(hlayer and hlayer["layer_name"] == "ForegroundInstances" and hlayer["is_visible"],
                  f"it went to the visible ForegroundInstances layer (got {hlayer and hlayer['layer_name']})")
            if hid is not None:
                try:
                    pg.wait_for_function(f"svre.kindOf({hid}) === 'drawn'", timeout=10000)
                    drawn = True
                except Exception:
                    drawn = False
                check(drawn, f"placed o_sv_house01 renders as drawn (id {hid}, kind={pg.evaluate(f'svre.kindOf({hid})')})")
                pg.keyboard.press("Control+z")
                gone = False
                for _ in range(40):
                    st, d = call("GET", f"/api/doc/{ROOM}")
                    if find_inst(d, hid) is None:
                        gone = True
                        break
                    time.sleep(0.25)
                check(gone, "Ctrl+Z undid the placement on the server")
                if gone:
                    try:
                        pg.wait_for_function(f"svre.kindOf({hid}) == null", timeout=10000)
                        removed = True
                    except Exception:
                        removed = False
                    check(removed, "undo removes it from the page too")

            print("sprite import live-refreshes the library")
            st, r = call("POST", "/api/mod-assets/import-sprite", {
                "sprite": "s_e2e_vase", "object": "o_e2e_vase", "by": "agent-test",
                "frames": [{"data": f0}]})
            check(st == 200, "a second sprite lands while the page is open")
            pg.click("#toolbox button[data-tool=place]")
            pg.wait_for_selector("#palette-dialog[open]", timeout=PALETTE_WAIT)
            pg.fill("#palette-q", "o_e2e_vase")
            try:
                pg.wait_for_function("document.querySelector('#palette-list li[data-o]')?.dataset.o === 'o_e2e_vase'", timeout=8000)
                live = True
            except Exception:
                live = False
            check(live, "the imported object appears in the open page's palette without reload (ws event)")
            check(pg.locator("#palette-list li[data-o] .mod-badge").count() >= 1, "it carries the mod badge")
            pg.keyboard.press("Escape")

            print("palette placement")
            pg.click("#toolbox button[data-tool=place]")
            pg.wait_for_selector("#palette-dialog[open]", timeout=PALETTE_WAIT)
            pg.fill("#palette-q", "o_chest")
            pg.wait_for_function("document.querySelector('#palette-list li[data-o]')?.dataset.o?.includes('chest')", timeout=5000)
            first = pg.locator("#palette-list li[data-o]").first
            obj = first.get_attribute("data-o")
            first.click()
            ps = pg.evaluate("svre.screen(390, 400)")
            pg.mouse.click(box["x"] + ps["x"], box["y"] + ps["y"])
            pg.keyboard.press("Escape")
            pg.wait_for_timeout(500)
            st, doc6 = call("GET", f"/api/doc/{ROOM}")
            new = [i for L in doc6["room"]["layers"] for i in L["layer_data"].get("instances", []) if i["object_definition"] == obj]
            check(len(new) >= 1, f"{obj} placed via the palette")
            if new:
                i = max(new, key=lambda x: x["instance_id"])
                check(i["x"] % 26 == 0 and i["y"] % 26 == 0, f"placed on a cell corner ({i['x']},{i['y']})")
                check(list(i.keys()) == list(insts[0].keys()), "new instance has the exporter's key order")
            check(doc6["log"][-1]["by"] == "human", "placement logged as human")
            check(mirror_ok(doc6["room"]), "placement mirrored into game_objects")

            print("functional-object tools")
            st, d0 = call("GET", f"/api/doc/{ROOM}")
            taken = {(i["x"] // 26, i["y"] // 26) for L in d0["room"]["layers"] for i in L["layer_data"].get("instances", []) if i["object_definition"] == "o_hut_wall"}
            spot = None
            for cx in range(1, 27):
                for cy in range(1, 25):
                    if all((cx + dx, cy + dy) not in taken for dx in (0, 1) for dy in (0, 1)):
                        spot = (cx, cy)
                        break
                if spot:
                    break
            check(spot is not None, "found a free 2x2 cell span for painting")
            # identify the collision layer structurally (vanilla spells it "Colissions")
            coll_name = next(L["layer_name"] for L in d0["room"]["layers"] if any(i["object_definition"] == "o_hut_wall" for i in L["layer_data"].get("instances", [])))
            box = pg.locator("#stage").bounding_box()
            pg.evaluate(f"svre.focus({spot[0] * 26 + 26}, {spot[1] * 26 + 26}, 2)")
            pg.wait_for_timeout(150)

            pg.click("#toolbox button[data-tool=collision]")
            check(pg.evaluate("svre.toolKind()") == "collision", "collision tool armed")
            # collision is a rectangle tool: one drag = ONE scaled o_hut_wall instance
            wall_ids0 = {i["instance_id"] for L in d0["room"]["layers"] for i in L["layer_data"].get("instances", []) if i["object_definition"] == "o_hut_wall"}
            p0 = pg.evaluate(f"svre.screen({spot[0] * 26 + 4}, {spot[1] * 26 + 4})")
            p1 = pg.evaluate(f"svre.screen({(spot[0] + 2) * 26 - 4}, {(spot[1] + 2) * 26 - 4})")
            pg.mouse.move(box["x"] + p0["x"], box["y"] + p0["y"])
            pg.mouse.down()
            pg.mouse.move(box["x"] + p1["x"], box["y"] + p1["y"], steps=5)
            pg.mouse.up()
            pg.wait_for_timeout(700)
            st, d1 = call("GET", f"/api/doc/{ROOM}")
            walls_new = [i for L in d1["room"]["layers"] for i in L["layer_data"].get("instances", []) if i["object_definition"] == "o_hut_wall" and i["instance_id"] not in wall_ids0]
            check(len(walls_new) == 1, f"one collision rectangle created ({len(walls_new)} new instances)")
            wrect = walls_new[0]
            check((wrect["x"], wrect["y"]) == (spot[0] * 26, spot[1] * 26), f"rect origin on the cell corner ({wrect['x']},{wrect['y']})")
            check((wrect["scale_x"], wrect["scale_y"]) == (2, 2), f"rect is a 2x2 cell span ({wrect['scale_x']}x{wrect['scale_y']})")
            lay = next((L["layer_name"] for L in d1["room"]["layers"] if any(i["instance_id"] == wrect["instance_id"] for i in L["layer_data"].get("instances", []))), None)
            check(lay == coll_name, f"rect landed in the collision layer ({lay})")
            check(d1["log"][-1]["label"] == "碰撞矩形 52×52", f"rect commit labelled ({d1['log'][-1]['label']})")

            # barrier brush (B): paints o_projectileBarrier cells; dedup/erase are per
            # object family, so barrier cells coexist with the collision rectangle
            btaken = {(i["x"] // 26, i["y"] // 26) for L in d0["room"]["layers"] for i in L["layer_data"].get("instances", []) if i["object_definition"] == "o_projectileBarrier"}
            span4 = {(spot[0] + dx, spot[1] + dy) for dx in (0, 1) for dy in (0, 1)}
            check(not (span4 & btaken), "the paint span is free of existing barriers")

            pg.click("#toolbox button[data-tool=barrier]")
            check(pg.evaluate("svre.toolKind()") == "barrier", "barrier tool armed")
            pg.mouse.move(box["x"] + p0["x"], box["y"] + p0["y"])
            pg.mouse.down()
            pg.mouse.move(box["x"] + p1["x"], box["y"] + p1["y"], steps=5)
            pg.mouse.up()
            pg.wait_for_timeout(700)
            st, db1 = call("GET", f"/api/doc/{ROOM}")
            barr1 = {(i["x"] // 26, i["y"] // 26) for L in db1["room"]["layers"] for i in L["layer_data"].get("instances", []) if i["object_definition"] == "o_projectileBarrier"}
            check(barr1 - btaken == span4, f"barrier brush painted a 2x2 span under the rect ({sorted(barr1 - btaken)})")
            blay = next((L["layer_name"] for L in db1["room"]["layers"] for i in L["layer_data"].get("instances", []) if (i["x"] // 26, i["y"] // 26) == spot and i["object_definition"] == "o_projectileBarrier"), None)
            check(blay == coll_name, f"no Projectiles layer: barriers fell back to the collision layer ({blay})")
            check(db1["log"][-1]["label"] == "涂刷屏障 4 格", f"barrier commit labelled ({db1['log'][-1]['label']})")

            # barrier erase removes only barriers; the collision rectangle survives
            pg.keyboard.down("Alt")
            pg.mouse.move(box["x"] + p0["x"], box["y"] + p0["y"])
            pg.mouse.down()
            pg.mouse.move(box["x"] + p1["x"], box["y"] + p1["y"], steps=5)
            pg.mouse.up()
            pg.keyboard.up("Alt")
            pg.wait_for_timeout(700)
            st, db2 = call("GET", f"/api/doc/{ROOM}")
            barr2 = {(i["x"] // 26, i["y"] // 26) for L in db2["room"]["layers"] for i in L["layer_data"].get("instances", []) if i["object_definition"] == "o_projectileBarrier"}
            wall_ids2 = {i["instance_id"] for L in db2["room"]["layers"] for i in L["layer_data"].get("instances", []) if i["object_definition"] == "o_hut_wall"}
            check(barr2 == btaken, "Alt+drag erased the barrier span")
            check(wrect["instance_id"] in wall_ids2, "the collision rectangle survived the barrier erase")

            # undo erase-barriers, paint-barriers, add-rect -> baseline
            for _ in range(3):
                pg.keyboard.press("Control+z")
                pg.wait_for_timeout(400)
            st, d2 = call("GET", f"/api/doc/{ROOM}")
            wall_ids3 = {i["instance_id"] for L in d2["room"]["layers"] for i in L["layer_data"].get("instances", []) if i["object_definition"] == "o_hut_wall"}
            barr3 = {(i["x"] // 26, i["y"] // 26) for L in d2["room"]["layers"] for i in L["layer_data"].get("instances", []) if i["object_definition"] == "o_projectileBarrier"}
            check(wall_ids3 == wall_ids0 and barr3 == btaken, "undo restored the baseline")

            pg.click("#toolbox button[data-tool=zone]")
            try:
                pg.wait_for_function("!document.querySelector('#opt-extra select')?.disabled", timeout=20000)
                zready = True
            except Exception:
                zready = False
            check(zready, "zone object picker populated")
            zone_obj = pg.eval_on_selector("#opt-extra select", "e => e.value")
            check(zone_obj == "oCameraStatic", f"zone tool defaults to oCameraStatic ({zone_obj})")
            cams0 = [i for L in d2["room"]["layers"] for i in L["layer_data"].get("instances", []) if i["object_definition"] == "oCameraStatic"]
            q0 = pg.evaluate(f"svre.screen({spot[0] * 26 + 2}, {spot[1] * 26 + 2})")
            q1 = pg.evaluate(f"svre.screen({(spot[0] + 4) * 26 - 2}, {(spot[1] + 2) * 26 - 2})")
            pg.mouse.move(box["x"] + q0["x"], box["y"] + q0["y"])
            pg.mouse.down()
            pg.mouse.move(box["x"] + q1["x"], box["y"] + q1["y"], steps=5)
            pg.mouse.up()
            pg.wait_for_timeout(700)
            st, d3 = call("GET", f"/api/doc/{ROOM}")
            cams = [i for L in d3["room"]["layers"] for i in L["layer_data"].get("instances", []) if i["object_definition"] == "oCameraStatic"]
            check(len(cams) == len(cams0) + 1, "zone draw added an oCameraStatic")
            znew = max(cams, key=lambda i: i["instance_id"])
            try:
                pg.wait_for_function(f"svre.geom({znew['instance_id']}) !== null", timeout=5000)
                g = pg.evaluate(f"svre.geom({znew['instance_id']})")
            except Exception:
                g = None
            check(g is not None and abs(znew["scale_x"] - 104 / g["lb"]["w"]) < 0.02 and abs(znew["scale_y"] - 52 / g["lb"]["h"]) < 0.02,
                  f"box scaled to the dragged span ({znew['scale_x']:.3f}x{znew['scale_y']:.3f})")
            zl = next((L["layer_name"] for L in d3["room"]["layers"] if any(i["instance_id"] == znew["instance_id"] for i in L["layer_data"].get("instances", []))), None)
            check(zl is not None and "amera" in zl, f"camera box landed in the camera layer ({zl})")
            pg.keyboard.press("Control+z")
            pg.wait_for_timeout(500)

            pg.click("#toolbox button[data-tool=marker]")
            mk = pg.eval_on_selector("#opt-extra select", "e => e.value")
            check(mk == "o_position_starter", f"marker tool defaults to o_position_starter ({mk})")
            starters0 = [i for L in d3["room"]["layers"] for i in L["layer_data"].get("instances", []) if i["object_definition"] == "o_position_starter"]
            mp = pg.evaluate(f"svre.screen({spot[0] * 26 + 130}, {spot[1] * 26 + 52})")
            pg.mouse.click(box["x"] + mp["x"], box["y"] + mp["y"])
            pg.wait_for_timeout(700)
            st, d4 = call("GET", f"/api/doc/{ROOM}")
            starters = [i for L in d4["room"]["layers"] for i in L["layer_data"].get("instances", []) if i["object_definition"] == "o_position_starter"]
            check(len(starters) == len(starters0) + 1, "marker click added an o_position_starter")
            mnew = max(starters, key=lambda i: i["instance_id"]) if starters else None
            check(mnew is not None and mnew["x"] % 26 == 0 and mnew["y"] % 26 == 0, f"marker snapped to a cell corner ({mnew and (mnew['x'], mnew['y'])})")
            check(d4["log"][-1]["label"].startswith("标记 o_position_starter"), f"marker commit labelled ({d4['log'][-1]['label']})")
            pg.keyboard.press("Control+z")
            pg.wait_for_timeout(500)
            pg.keyboard.press("Escape")

            print("barrier marker renders with its real sprite")
            # o_barrier_marker is visible=true (sprite0: a uniform green square) but
            # buried under the -y walls it annotates -- the canvas shows it in the
            # hidden overlay band (faded, default-visible) with its real sprite
            # NOTE: by must differ from the page's own author ("human") -- the page
            # ignores WS echoes of its own author, so an HTTP "human" apply would
            # never rebuild the canvas
            st, r = call("POST", f"/api/doc/{ROOM}/apply", {
                "by": "agent-test", "label": "放个屏障标记",
                "ops": [{"op": "add", "layer": "ForegroundInstances",
                         "inst": {"object_definition": "o_barrier_marker", "x": 52, "y": 52,
                                  "scale_x": 2, "scale_y": 3}}]})
            bmid = r["ids"][0] if st == 200 else None
            check(bmid is not None, "added an o_barrier_marker")
            if bmid:
                # ws -> refetch -> rebuild, polled like the other async chains here
                try:
                    pg.wait_for_function(f"svre.kindOf({bmid}) === 'hidden'", timeout=10000)
                    ok_kind = True
                except Exception:
                    ok_kind = False
                check(ok_kind, "barrier marker joins the hidden overlay band")
                vi = pg.evaluate(f"svre.viewInfo({bmid})")
                check(vi is not None and vi["kids"] == ["Sprite"] and vi["a"] == 1,
                      f"marker view = real sprite at natural alpha, no label/diamond ({vi})")
                # the spot sits under a giant o_hut_wall: the collision band outranks
                # the hidden band in pick, like for every covered object
                check(pg.evaluate(f"svre.pickPoint({bmid})") is None, "collision stamps outrank it in pick (band order)")
                pg.evaluate("svre.set('collision', false)")
                check(pg.evaluate(f"svre.pickPoint({bmid})") is not None, "clickable once the collision band is off (documented workflow)")
                pg.evaluate("svre.set('collision', true)")
                st, r = call("POST", f"/api/doc/{ROOM}/undo", {"by": "agent-test"})
                check(st == 200, "agent undo removed the barrier marker")

            wv = pg.evaluate("svre.viewInfo(117533)")  # an o_wall_parent (s_pbluebox)
            check(wv is not None and wv["kids"] == ["Sprite"] and wv["a"] == 1,
                  f"o_wall_parent shows s_pbluebox at natural alpha like UTMT ({wv})")

            print("instance layers tab")
            pg.click(".tabs button[data-tab=insts]")
            pg.wait_for_timeout(200)
            n_rows = pg.evaluate("svre.instRowCount()")
            st, d5 = call("GET", f"/api/doc/{ROOM}")
            total = sum(len(L["layer_data"].get("instances", [])) for L in d5["room"]["layers"])
            check(n_rows == total, f"图层 tab lists every instance ({n_rows}/{total})")
            fg = next(L for L in d5["room"]["layers"] if L["layer_name"] == "ForegroundInstances")
            fid = fg["layer_data"]["instances"][0]["instance_id"]
            pg.click(f"#inst-list li.inst[data-id='{fid}']")
            pg.wait_for_timeout(200)
            check(pg.evaluate("svre.selection") == [fid], f"row click selects #{fid}")
            check(pg.eval_on_selector(f"#inst-list li.inst[data-id='{fid}']", "e => e.classList.contains('sel')"), "row highlights on selection")
            check(pg.evaluate(f"svre.visOf({fid})") is True, "row starts visible")
            pg.click(f"#inst-list li.inst[data-id='{fid}'] .eye")
            pg.wait_for_timeout(200)
            check(pg.evaluate(f"svre.visOf({fid})") is False, "eye hides the instance in the editor")
            check(pg.eval_on_selector(f"#inst-list li.inst[data-id='{fid}']", "e => e.classList.contains('off')"), "row dims when hidden")
            pg.click(f"#inst-list li.inst[data-id='{fid}'] .eye")
            pg.wait_for_timeout(200)
            check(pg.evaluate(f"svre.visOf({fid})") is True, "eye again shows it")

            # dragging a row onto another row's top half moves it just in front of that row
            col = next(L for L in d5["room"]["layers"] if L["layer_name"] == coll_name)
            arr = [i["instance_id"] for i in col["layer_data"]["instances"]]
            A, C = arr[-3], arr[-1]
            pg.locator(f"#inst-list li.inst[data-id='{A}']").drag_to(
                pg.locator(f"#inst-list li.inst[data-id='{C}']"), target_position={"x": 60, "y": 2})
            pg.wait_for_timeout(700)
            st, d6 = call("GET", f"/api/doc/{ROOM}")
            arr6 = [i["instance_id"] for i in next(L for L in d6["room"]["layers"] if L["layer_name"] == coll_name)["layer_data"]["instances"]]
            check(len(arr6) == len(arr) and arr6[-1] == A and arr6[-2] == C, f"row drag reordered the layer array (front-most now #{A})")
            check(d6["log"][-1]["label"].startswith("调整顺序"), f"reorder labelled ({d6['log'][-1]['label']})")
            # the canvas draw order (pixi's own children array) must flip with the array:
            # collision stamps share one constant overlay z, so their order is pixi's
            # stable child order = build order = the layer array order
            zo = {e["id"]: e["ord"] for e in pg.evaluate("svre.drawOrder()")}
            check(zo.get(A, -1) > zo.get(C, -1), f"canvas draw order flipped with the array (#{A} above #{C})")
            pg.keyboard.press("Control+z")
            pg.wait_for_timeout(600)
            st, d7 = call("GET", f"/api/doc/{ROOM}")
            arr7 = [i["instance_id"] for i in next(L for L in d7["room"]["layers"] if L["layer_name"] == coll_name)["layer_data"]["instances"]]
            check(arr7 == arr, "Ctrl+Z restores the layer order")
            zo7 = {e["id"]: e["ord"] for e in pg.evaluate("svre.drawOrder()")}
            check(zo7.get(A, -1) < zo7.get(C, -1), "canvas draw order restored with the array")

            print("game draw order: same-depth ties break by creation order")
            # the canvas simulates runtime depth (game mode is the default). o_bush01
            # is depth=-y+18, and this pair shares y=26 -> same depth -> the tie breaks
            # by creation order (game_objects): 999002, appended after 999001, draws on
            # top; relayering syncs game_objects, so the canvas tie flips with it.
            # A visible layer, or the bushes would classify into the hidden band.
            fg_name = next(L["layer_name"] for L in d0["room"]["layers"]
                           if L["layer_name"] == "ForegroundInstances")
            st, d8 = call("POST", f"/api/doc/{ROOM}/apply", {"by": "agent-test", "label": "钉住顺序测试 A", "ops": [
                {"op": "add", "layer": fg_name, "inst": {"x": 26, "y": 26, "object_definition": "o_bush01", "instance_id": 999001,
                 "creation_code": None, "scale_x": 1, "scale_y": 1, "color": 4294967295, "rotation": 0, "pre_create_code": None, "image_speed": 1, "image_index": 0}},
                {"op": "add", "layer": fg_name, "inst": {"x": 52, "y": 26, "object_definition": "o_bush01", "instance_id": 999002,
                 "creation_code": None, "scale_x": 1, "scale_y": 1, "color": 4294967295, "rotation": 0, "pre_create_code": None, "image_speed": 1, "image_index": 0}},
            ]})
            check(st == 200, f"two same-depth bushes added ({st})")
            # ws -> refetch -> rebuild is async; poll until the nodes exist
            ok_add = True
            try:
                pg.wait_for_function("svre.kindOf(999001) && svre.kindOf(999002)", timeout=10000)
            except Exception:
                ok_add = False
            check(ok_add, "bush nodes rebuilt on the canvas")
            za = pg.evaluate("svre.viewInfo(999001) && svre.viewInfo(999001).z")
            zb = pg.evaluate("svre.viewInfo(999002) && svre.viewInfo(999002).z")
            check(za is not None and zb is not None and zb > za,
                  f"later creation order draws on top at equal depth ({zb} > {za})")
            # reorder: 999002 before 999001 in the same layer -> its canvas z must drop
            # below 999001's (game_objects follows along, the runtime creation order)
            st, d9 = call("POST", f"/api/doc/{ROOM}/apply", {"by": "agent-test", "label": "调整顺序 o_bush01", "ops": [
                {"op": "relayer", "id": 999002, "layer": fg_name, "before": 999001, "expect": {"layer": fg_name}},
            ]})
            check(st == 200, f"relayer applied ({st})")
            pg.wait_for_timeout(800)
            za2 = pg.evaluate("svre.viewInfo(999001) && svre.viewInfo(999001).z")
            zb2 = pg.evaluate("svre.viewInfo(999002) && svre.viewInfo(999002).z")
            check(zb2 is not None and za2 is not None and zb2 < za2,
                  f"reorder flips the creation-order tie ({zb2} < {za2})")
            st, d10 = call("GET", f"/api/doc/{ROOM}")
            go = [g["instance_id"] for g in d10["room"]["game_objects"]]
            check(go.index(999002) < go.index(999001), "game_objects mirrors the reorder")
            call("POST", f"/api/doc/{ROOM}/undo", {"by": "agent-test"})
            call("POST", f"/api/doc/{ROOM}/undo", {"by": "agent-test"})
            pg.wait_for_timeout(400)

            print("game vs static: depth rules the canvas, selection lifts, relayer speaks up")
            # a pair where the two orders DISAGREE: depth=-y+18 puts the lower (bigger
            # y) bush in front in game truth no matter where it sits in the layer
            # array. 999003 at y=78 added FIRST, 999004 at y=26 SECOND.
            st, d11 = call("POST", f"/api/doc/{ROOM}/apply", {"by": "agent-test", "label": "钉住顺序测试 B", "ops": [
                {"op": "add", "layer": fg_name, "inst": {"x": 182, "y": 78, "object_definition": "o_bush01", "instance_id": 999003,
                 "creation_code": None, "scale_x": 1, "scale_y": 1, "color": 4294967295, "rotation": 0, "pre_create_code": None, "image_speed": 1, "image_index": 0}},
                {"op": "add", "layer": fg_name, "inst": {"x": 182, "y": 26, "object_definition": "o_bush01", "instance_id": 999004,
                 "creation_code": None, "scale_x": 1, "scale_y": 1, "color": 4294967295, "rotation": 0, "pre_create_code": None, "image_speed": 1, "image_index": 0}},
            ]})
            check(st == 200, f"disagreeing bush pair added ({st})")
            ok_add2 = True
            try:
                pg.wait_for_function("svre.kindOf(999003) && svre.kindOf(999004)", timeout=10000)
            except Exception:
                ok_add2 = False
            check(ok_add2, "pair rebuilt on the canvas")
            check(pg.evaluate("svre.zmode()") == "game", "game mode is the default")
            z3 = pg.evaluate("svre.viewInfo(999003).z")
            z4 = pg.evaluate("svre.viewInfo(999004).z")
            check(z3 > z4, f"game mode: runtime depth=-y rules, not array position ({z3} > {z4})")
            pg.evaluate("svre.zmode('static')")
            zs3 = pg.evaluate("svre.viewInfo(999003).z")
            zs4 = pg.evaluate("svre.viewInfo(999004).z")
            check(zs4 > zs3, f"static mode: later in the layer array draws on top ({zs4} > {zs3})")
            pg.evaluate("svre.zmode('game')")
            check(pg.evaluate("svre.viewInfo(999003).z") > pg.evaluate("svre.viewInfo(999004).z"), "back to game truth")

            # a UI row drag relayers the pair: the depth-coded toast must speak up,
            # and the game order still must not flip (a tie fraction can't cross a
            # depth gap) even though game_objects mirrors the drag
            pg.wait_for_selector("#inst-list li.inst[data-id='999003']", timeout=5000)
            pg.locator("#inst-list li.inst[data-id='999003']").drag_to(
                pg.locator("#inst-list li.inst[data-id='999004']"), target_position={"x": 60, "y": 2})
            ok_toast = True
            try:
                pg.wait_for_selector(".toast:has-text('调序不影响游戏内遮挡')", timeout=5000)
            except Exception:
                ok_toast = False
            check(ok_toast, "reordering a depth=-y object toasts that the game won't care")
            pg.wait_for_timeout(900)
            st, d12 = call("GET", f"/api/doc/{ROOM}")
            arrB = [i["instance_id"] for i in next(L for L in d12["room"]["layers"] if L["layer_name"] == fg_name)["layer_data"]["instances"]]
            check(arrB.index(999003) > arrB.index(999004), "row drag relayered the pair (999003 now later in the array)")
            goB = [g["instance_id"] for g in d12["room"]["game_objects"]]
            check(goB.index(999003) > goB.index(999004), "game_objects mirrors the drag (creation-order twin)")
            pg.keyboard.press("v")  # make Escape mean "clear selection", not "switch tool"
            pg.keyboard.press("Escape")  # the drag selected 999003; drop the lift
            pg.wait_for_timeout(300)
            z3b = pg.evaluate("svre.viewInfo(999003).z")
            z4b = pg.evaluate("svre.viewInfo(999004).z")
            check(z3b > z4b, f"game order unchanged by the relayer ({z3b} > {z4b})")

            # selection lift: the covered instance renders above everything while held
            pg.click("#inst-list li.inst[data-id='999004']")
            pg.wait_for_timeout(300)
            zl4 = pg.evaluate("svre.viewInfo(999004).z")
            check(zl4 > 1e8 and zl4 > pg.evaluate("svre.viewInfo(999003).z"), f"selected instance lifts above the scene ({zl4})")
            pg.keyboard.press("Escape")
            pg.wait_for_timeout(300)
            check(pg.evaluate("svre.viewInfo(999003).z") > pg.evaluate("svre.viewInfo(999004).z"), "deselect drops it back to the true order")
            pg.keyboard.press("Control+z")  # undo the row drag (page author's entry)
            pg.wait_for_timeout(700)
            call("POST", f"/api/doc/{ROOM}/undo", {"by": "agent-test"})  # undo the pair add
            pg.wait_for_timeout(400)

            print("compile from the page")
            pg.keyboard.press("Control+s")
            pg.wait_for_timeout(800)
            st, doc7 = call("GET", f"/api/doc/{ROOM}")
            disk = target.read_bytes().decode("utf-8")
            check(doc7["dirty"] is False, "compiled: no longer dirty")
            check(obj in disk, f"compiled file contains {obj}")

            print("vanilla room: read-only channel")
            XY = "(id) => { for (const L of svre.doc.room.layers) { const a = L.layer_data.instances; if (!a) continue; const i = a.find(i => i.instance_id === id); if (i) return [i.x, i.y]; } return null; }"
            pg.goto(f"{BASE}/?room=r_Osbrook&vanilla=1")
            pg.wait_for_function("document.getElementById('load-state').textContent.includes('只读')", timeout=120000)
            check(pg.evaluate("svre.doc.vanilla") is True, "the client knows this doc is vanilla")
            check(pg.evaluate("svre.readOnly") is True, "read-only flag is up")
            check(pg.evaluate("document.body.classList.contains('vanilla-ro')"), "vanilla-ro body class")
            check(pg.evaluate("document.getElementById('b-compile').disabled") is True, "compile button inert")
            pe = pg.evaluate("getComputedStyle(document.querySelector(\"#toolbox button[data-tool='collision']\")).pointerEvents")
            check(pe == "none", "edit tool buttons inert")
            check("只读" in (pg.text_content("#banner") or ""), "banner announces read-only")
            check(pg.evaluate("document.querySelector('#room-select option[data-vanilla]')?.value ?? null") == "r_Osbrook",
                  "the dropdown marks the open vanilla room")
            # view affordances stay live: z-order toggle and the selection lift
            check(pg.evaluate("svre.zmode()") == "game", "game order is the default in vanilla too")
            pg.evaluate("svre.zmode('static')")
            check(pg.evaluate("svre.zmode()") == "static", "static audit view toggles in vanilla")
            pg.evaluate("svre.zmode('game')")
            pg.fill("#insts-q", "light02")
            pg.wait_for_timeout(400)
            row = pg.locator("#inst-list li.inst").first
            vid = int(row.get_attribute("data-id"))
            row.click()
            pg.wait_for_timeout(400)
            check(pg.evaluate("svre.selection") == [vid], f"row click selects in vanilla (#{vid})")
            zl = pg.evaluate(f"svre.viewInfo({vid}).z")
            check(zl is not None and zl > 1e8, f"selection lift works in vanilla ({zl})")
            pg.evaluate("document.activeElement?.blur()")  # keys must reach the window handler, not the filter input
            xy0 = pg.evaluate(XY, vid)
            # edit refusals: tool keys, Delete, arrows and a canvas drag all change nothing
            pg.keyboard.press("c")
            check(pg.evaluate("svre.toolKind()") == "select", "edit tool keys refused")
            check(pg.locator(".toast:has-text('只读')").count() > 0, "the refusal says why")
            n0 = pg.evaluate("svre.instRowCount()")
            pg.keyboard.press("Delete")
            pg.wait_for_timeout(300)
            check(pg.evaluate("svre.instRowCount()") == n0, "Delete removes nothing")
            pg.keyboard.press("ArrowRight")
            pg.wait_for_timeout(300)
            check(pg.evaluate(XY, vid) == xy0, "arrow nudge refused")
            pg.evaluate(f"svre.focus({xy0[0]}, {xy0[1]}, 3)")
            pg.wait_for_timeout(200)
            pt = pg.evaluate(f"svre.pickPoint({vid})")
            check(pt is not None, "the selected (lifted) instance is pickable for a drag attempt")
            if pt:
                sb = pg.locator("#stage").bounding_box()
                pg.mouse.move(sb["x"] + pt["x"], sb["y"] + pt["y"])
                pg.mouse.down()
                pg.mouse.move(sb["x"] + pt["x"] + 60, sb["y"] + pt["y"], steps=4)
                pg.mouse.up()
                pg.wait_for_timeout(400)
                check(pg.evaluate(XY, vid) == xy0, "canvas drag moves nothing")
            check(pg.evaluate("svre.doc.rev") == 0 and pg.evaluate("svre.doc.log.length") == 0, "no log entries were created")
            # the picker's own path: dropdown group -> search -> pre-selected first hit -> 打开
            pg.goto(f"{BASE}/?room={ROOM}")
            pg.wait_for_function("document.getElementById('load-state').textContent.includes('可见')", timeout=60000)
            pg.select_option("#room-select", "__vanilla_pick__")
            pg.wait_for_selector("#vanilla-dialog[open]", timeout=5000)
            pg.fill("#vd-q", "deliverycart")
            pg.wait_for_timeout(400)
            check(pg.evaluate("document.getElementById('vd-list').value") == "r_prce_DeliveryCart_Osbrook",
                  "the picker pre-selects the first hit (a list box does not do it alone)")
            pg.click("#vd-ok")
            pg.wait_for_function("document.getElementById('load-state').textContent.includes('只读')", timeout=60000)
            check(pg.evaluate("svre.doc.name") == "r_prce_DeliveryCart_Osbrook" and pg.evaluate("svre.readOnly") is True,
                  "the picker opens its pick read-only")

            print("UI theme: day/night chrome")
            check(pg.evaluate("svre.theme") == "dark", "default theme is dark")
            bg_dark = pg.evaluate("getComputedStyle(document.documentElement).backgroundColor")
            sheet_dark = pg.evaluate("svre.canvasColors.sheet")
            check(sheet_dark == 0x0d0e11, "night canvas: dark artboard sheet")
            pg.click("#b-view")  # theme lives in the 视图 dropdown now
            pg.click("#b-theme")
            pg.wait_for_timeout(200)
            check(pg.evaluate("svre.theme") == "light", "the toggle switches to the day theme")
            check(pg.evaluate("document.documentElement.dataset.theme") == "light", "data-theme follows")
            check(pg.evaluate("localStorage.getItem('svre.theme')") == "light", "the choice is persisted")
            bg_light = pg.evaluate("getComputedStyle(document.documentElement).backgroundColor")
            check(bg_light != bg_dark, f"the backdrop actually changed ({bg_dark} -> {bg_light})")
            cc = pg.evaluate("svre.canvasColors")
            check(cc["sheet"] == 0xd3d0c9 and cc["sheet"] != sheet_dark, "the artboard sheet follows the theme (warm paper, not white)")
            check(cc["gridLine"] == 0x101014 and cc["gridMajor"] == 0xa67c00, "grid chrome darkens for the light sheet")
            check(cc["voidBg"] == 0xb9b6af and cc["bounds"] == 0xa67c00, "pasteboard and bounds follow too")
            pg.reload()
            pg.wait_for_function("document.getElementById('load-state').textContent.includes('只读')", timeout=120000)
            check(pg.evaluate("svre.theme") == "light", "the theme survives a reload")
            pg.click("#b-view")  # choosing a command closed the dropdown -- reopen it
            pg.click("#b-theme")
            pg.wait_for_timeout(200)
            check(pg.evaluate("svre.theme") == "dark", "and toggles back to night")

            print("menu dispatcher (electron ids, browser page)")
            check(pg.evaluate("svre.electron") is False, "no host bridge in a plain browser")
            check(pg.evaluate("svre.menu('view.theme.light')") is True and pg.evaluate("svre.theme") == "light", "menu: theme light")
            check(pg.evaluate("svre.menu('view.theme.dark')") is True and pg.evaluate("svre.theme") == "dark", "menu: theme dark")
            check(pg.evaluate("svre.menu('view.zmode.static')") is True and pg.evaluate("svre.zmode()") == "static", "menu: zmode static")
            check(pg.evaluate("svre.menu('view.zmode.game')") is True and pg.evaluate("svre.zmode()") == "game", "menu: zmode game")
            check(pg.evaluate("svre.menu('view.toggle.grid')") is True and pg.evaluate("document.getElementById('t-grid').checked") is True, "menu: grid on")
            check(pg.evaluate("svre.menu('view.toggle.grid')") is True and pg.evaluate("document.getElementById('t-grid').checked") is False, "menu: grid off")
            check(pg.evaluate("svre.menu('tool.hand')") is True and pg.evaluate("svre.toolKind()") == "hand", "menu: hand tool arms (allowed read-only)")
            check(pg.evaluate("svre.menu('tool.select')") is True and pg.evaluate("svre.toolKind()") == "select", "menu: back to select")
            check(pg.evaluate("svre.menu('view.one')") is True, "menu: 1:1 zoom dispatches")
            check(pg.evaluate("svre.menu('edit.find')") is True and pg.evaluate("document.activeElement.id") == "insts-q", "menu: find focuses the instance filter")
            check(pg.evaluate("svre.menu('file.importSprite')") is True and pg.evaluate("document.getElementById('sprite-dialog').open") is True,
                  "menu: import-sprite opens its dialog")
            pg.click("#sd-cancel")
            check(pg.evaluate("document.getElementById('sprite-dialog').open") is False, "import-sprite dialog closes on cancel")
            check(pg.evaluate("svre.menu('bogus.id')") is False, "unknown menu ids are refused")

            pg.goto(f"{BASE}/?room=r_Osbrook&vanilla=1&render=1")
            pg.wait_for_function("window.svreReady === true", timeout=120000)
            check(pg.evaluate("svre.doc.vanilla") is True, "render mode opens the vanilla room read-only")

            check(not errors, f"no page errors {errors}")
            browser.close()

        check(not (scratch / "rooms" / "r_Osbrook.room.json").exists(), "viewing a vanilla room writes no project file")

        print("C. first-run setup wizard (degraded backend)")
        # a second server whose config points at nothing: no moddir, no cache. SVRE_CONFIG
        # keeps every write it makes inside the scratch dir. This is the packaged fresh
        # install, and it is the welcome state, not a defect: the machine gaps (cache) and
        # "no project open" are two different axes.
        ss = Path(tempfile.mkdtemp(prefix="svre-e2e-setup-"))
        scfg = ss / "svre.config.json"
        scfg.write_text(json.dumps({"modDir": "", "assetsDir": str(ss / "no-cache"),
                                    "sourceDir": "", "vanillaWin": "", "utmtCli": ""}), encoding="utf-8")
        base2 = f"http://localhost:{SETUP_PORT}"

        def call2(method, path, body=None):
            req = urllib.request.Request(base2 + path, method=method,
                                         data=json.dumps(body).encode() if body is not None else None,
                                         headers={"Content-Type": "application/json"} if body is not None else {})
            try:
                with urllib.request.urlopen(req, timeout=10) as r:
                    return r.status, json.loads(r.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                try:
                    return e.code, json.loads(e.read().decode("utf-8"))
                except json.JSONDecodeError:
                    return e.code, None

        env2 = {**os.environ, "SVRE_CONFIG": str(scfg)}
        server2 = subprocess.Popen("npx vite --port %d --strictPort" % SETUP_PORT, cwd=ROOT, env=env2, shell=True,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
        try:
            for _ in range(120):
                try:
                    urllib.request.urlopen(f"{base2}/api/setup", timeout=1)
                    break
                except Exception:
                    time.sleep(0.5)

            st, s = call2("GET", "/api/setup")
            check(st == 200 and s["mode"] == "welcome" and s["reasons"] == ["cache"],
                  f"no project is welcome mode, not a machine gap ({s.get('mode')} / {s.get('reasons')})")
            check(s["project"] is None and "needed" not in s, "no project object, and no `needed` flag survives")
            check(s.get("expected", {}).get("game") == "0.9.4.25", "the pinned version fingerprint ships with the editor")
            check(isinstance(s.get("detected"), list), "setup reports detected game installs")
            st, p = call2("GET", "/api/projects")
            check(st == 200 and p["current"] is None and p["recent"] == [], f"projects answers even with nothing open ({p})")
            st, r = call2("GET", "/api/rooms")
            check(st == 503 and r.get("setup") is True and r.get("mode") == "welcome",
                  "every other /api route 503s, and says which screen to go to")
            st, r = call2("GET", "/api/config")
            check(st == 200, "/api/config still answers (the shell needs it)")

            # opening a folder IS the old "workdir step", and it is not a step in a wizard:
            # it is what the welcome page's 打开文件夹… does. A bare folder gets one
            # confirmation (the open fills in a skeleton), never a refusal.
            st, r = call2("POST", "/api/projects/open", {"path": str(ss / "mod")})
            check(st == 409 and r.get("detail", {}).get("code") == "unfamiliar",
                  f"a folder that is not a mod tree asks once ({st})")
            check(not (ss / "mod").exists(), "and nothing is written before the user confirms")
            st, r = call2("POST", "/api/projects/open", {"path": str(ss / "mod"), "force": True})
            check(st == 200 and (ss / "mod" / "assets.json").exists() and (ss / "mod" / "rooms").is_dir(),
                  "confirming creates the project skeleton")
            check(r["setup"]["mode"] == "setup" and r["setup"]["reasons"] == ["cache"],
                  "open succeeds; the machine is the thing still missing")
            check(json.loads(scfg.read_text(encoding="utf-8"))["modDir"] == str(ss / "mod"), "the choice persists to the scratch config")
            st, p = call2("GET", "/api/projects")
            check(p["current"]["exists"] is True and [x["name"] for x in p["recent"]] == ["mod"],
                  f"the opened project is current and heads the recent list ({p})")
            st, r = call2("GET", "/api/rooms")
            check(st == 503 and r.get("mode") == "setup", "still degraded until the extract lands")
            st, r = call2("POST", "/api/projects/open", {"path": "C:\\"})
            check(st == 400, "a drive root is refused as a project")

            # a project whose folder vanished (deleted on disk, or a config copied from
            # another machine) is welcome mode too -- and survives a restart of the server
            st, r = call2("POST", "/api/projects/close")
            check(st == 200 and r["setup"]["mode"] == "welcome" and r["setup"]["project"] is None,
                  "closing a project lands on the welcome page")
            check(json.loads(scfg.read_text(encoding="utf-8"))["modDir"] == "", "and it persists as no project")
            st, p = call2("GET", "/api/projects")
            check([x["name"] for x in p["recent"]] == ["mod"] and p["current"] is None,
                  "关闭项目 keeps the folder in the recent list (that is the way back)")
            st, r = call2("GET", "/api/rooms")
            check(st == 503 and r.get("mode") == "welcome", "and the gate closes again")

            st, r = call2("POST", "/api/setup/extract", {"vanillaWin": str(ss / "nope.win")})
            check(st == 400, "extract refuses a missing data file")
            fake = ss / "fake.win"
            fake.write_bytes(b"tiny")
            st, r = call2("POST", "/api/setup/extract", {"vanillaWin": str(fake)})
            check(st == 400 and "MB" in str(r.get("error", "")), "extract refuses a file too small to be data.win")

        finally:
            subprocess.run(f"taskkill /PID {server2.pid} /T /F", shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            shutil.rmtree(ss, ignore_errors=True)

        print("C2. welcome page + machine setup in the browser (fresh degraded backend)")
        # its own scratch + server: the HTTP pins above already opened a project here, and
        # the app's first screen depends on what is still missing
        ss2 = Path(tempfile.mkdtemp(prefix="svre-e2e-setupui-"))
        scfg2 = ss2 / "svre.config.json"
        scfg2.write_text(json.dumps({"modDir": str(ss2 / "mod"), "assetsDir": str(ss2 / "no-cache"),
                                     "sourceDir": "", "vanillaWin": "", "utmtCli": ""}), encoding="utf-8")
        base3 = f"http://localhost:{SETUP_UI_PORT}"
        env3 = {**os.environ, "SVRE_CONFIG": str(scfg2)}
        server3 = subprocess.Popen("npx vite --port %d --strictPort" % SETUP_UI_PORT, cwd=ROOT, env=env3, shell=True,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
        try:
            for _ in range(120):
                try:
                    urllib.request.urlopen(f"{base3}/api/setup", timeout=1)
                    break
                except Exception:
                    time.sleep(0.5)
            fake2 = ss2 / "fake.win"
            fake2.write_bytes(b"tiny")
            with sync_playwright() as p2:
                b2 = p2.chromium.launch()
                pg2 = b2.new_page(viewport={"width": 1280, "height": 860})
                pg2.goto(base3)
                # no project: the welcome page, NOT the wizard. The editor chrome is gone but
                # the titlebar (drag region + window buttons) stays.
                pg2.wait_for_selector("#welcome:not([hidden])", timeout=60000)
                check(pg2.evaluate("getComputedStyle(document.getElementById('options')).display") == "none",
                      "with no project the editor chrome is hidden")
                # #titlebar exists only in the shell, where the page carries body.electron:
                # what the welcome page must not do is take it away (drag region + window
                # buttons). Wearing the class is the only way to see that from a browser.
                pg2.evaluate("document.body.classList.add('electron')")
                check(pg2.evaluate("getComputedStyle(document.getElementById('titlebar')).display") != "none",
                      "the title bar stays (it is the drag region and holds the window buttons)")
                pg2.evaluate("document.body.classList.remove('electron')")
                check(pg2.evaluate("document.getElementById('setup-dialog').open") is False,
                      "the wizard does not open by itself when there is no project")
                check("资产缓存" in pg2.inner_text("#wc-machine"),
                      "the welcome page's machine strip names what this install is missing")
                pg2.click("#wc-machine button")
                pg2.wait_for_selector("#setup-dialog[open]", timeout=10000)
                check(pg2.evaluate("document.getElementById('setup-step-win').hidden") is False,
                      "本机设置 starts at the data file (step 1 of 3)")
                pg2.keyboard.press("Escape")
                check(pg2.evaluate("document.getElementById('setup-dialog').open") is True,
                      "Esc cannot dismiss it: the cache is missing, so there is nothing behind it")
                check("0.9.4.25" in pg2.inner_text("#setup-expected"), "win step names the pinned game version")
                pg2.click("#setup-extract")
                pg2.wait_for_selector("#msg-dialog[open]", timeout=5000)
                check(True, "an empty data-file path gets an in-page warning (never a native dialog)")
                pg2.click("#md-ok")
                pg2.fill("#setup-win", str(fake2))
                pg2.click("#setup-extract")
                pg2.wait_for_selector("#setup-step-run:not([hidden]) #setup-result .warn", timeout=10000)
                check(pg2.evaluate("document.getElementById('setup-retry').hidden") is False, "a failed extract offers retry")
                pg2.click("#setup-retry")
                pg2.wait_for_selector("#setup-step-win:not([hidden])", timeout=5000)
                check(True, "retry returns to the data-file step")
                b2.close()
        finally:
            subprocess.run(f"taskkill /PID {server3.pid} /T /F", shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            shutil.rmtree(ss2, ignore_errors=True)

        print("C3. source scan step: create.json from decompiled GML")
        # a fourth server: cache present, create.json missing. The cache here is synthetic
        # (two objects, one of them with Create/Draw source) so the scan is a REAL child
        # process -- scan-create.mjs -- just a tiny one. create.json is the only cache file
        # data.win cannot produce, so this step is what makes the wizard's output complete.
        ss4 = Path(tempfile.mkdtemp(prefix="svre-e2e-scan-"))
        cache4 = ss4 / "cache"
        src4 = ss4 / "src"
        (cache4 / "rooms").mkdir(parents=True)
        src4.mkdir()
        (ss4 / "mod").mkdir()
        (ss4 / "mod" / "assets.json").write_text('{"sprites": {}, "objects": {}}', encoding="utf-8")
        (cache4 / "objects.json").write_text(json.dumps({
            "o_test_parent": {"parent": "", "events": [], "sprite": -1},
            "o_test_child": {"parent": "o_test_parent", "events": [[0, 0], [8, 0]], "sprite": -1},
        }), encoding="utf-8")
        (cache4 / "sprites.json").write_text("{}", encoding="utf-8")
        (cache4 / "rooms.json").write_text("[]", encoding="utf-8")
        (cache4 / "rooms" / "_index.json").write_text("{}", encoding="utf-8")
        # the shapes the scanner knows: a Create that moves itself, a Draw that draws its sprite
        (src4 / "gml_Object_o_test_child_Create_0.gml").write_text("depth = -y + 18;\n", encoding="utf-8")
        (src4 / "gml_Object_o_test_child_Draw_0.gml").write_text("draw_self();\n", encoding="utf-8")
        scfg4 = ss4 / "svre.config.json"
        scfg4.write_text(json.dumps({"modDir": str(ss4 / "mod"), "assetsDir": str(cache4),
                                     "sourceDir": "", "vanillaWin": "", "utmtCli": ""}), encoding="utf-8")
        base4 = f"http://localhost:{SETUP_SCAN_PORT}"
        env4 = {**os.environ, "SVRE_CONFIG": str(scfg4)}

        def call4(method, path, body=None):
            req = urllib.request.Request(base4 + path, method=method,
                                         data=json.dumps(body).encode() if body is not None else None,
                                         headers={"Content-Type": "application/json"} if body is not None else {})
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    return r.status, json.loads(r.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                try:
                    return e.code, json.loads(e.read().decode("utf-8"))
                except json.JSONDecodeError:
                    return e.code, None

        server4 = subprocess.Popen("npx vite --port %d --strictPort" % SETUP_SCAN_PORT, cwd=ROOT, env=env4, shell=True,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
        try:
            for _ in range(120):
                try:
                    urllib.request.urlopen(f"{base4}/api/setup", timeout=1)
                    break
                except Exception:
                    time.sleep(0.5)

            st, s = call4("GET", "/api/setup")
            check(st == 200 and s["reasons"] == ["create"], f"a complete cache without depth facts asks for exactly that ({s.get('reasons')})")
            check(s["sourceGml"] == 0, "no source tree remembered yet")
            st, r = call4("GET", "/api/rooms")
            check(st == 503, "the app stays degraded until the depth facts exist")

            st, r = call4("POST", "/api/setup/create", {"sourceDir": str(ss4 / "nope")})
            check(st == 400 and "gml_Object_" in str(r.get("error", "")), "a folder with no decompiled GML is refused")

            with sync_playwright() as p4:
                b4 = p4.chromium.launch()
                pg4 = b4.new_page(viewport={"width": 1280, "height": 860})
                pg4.goto(base4)
                pg4.wait_for_selector("#setup-dialog[open]", timeout=60000)
                check(pg4.evaluate("document.getElementById('setup-step-create').hidden") is False,
                      "with only the depth facts missing the wizard opens straight on that step")
                check(pg4.evaluate("document.getElementById('setup-source-pick').hidden") is True,
                      "the native folder picker is hidden in a plain browser")
                pg4.click("#setup-create-run")
                pg4.wait_for_selector("#msg-dialog[open]", timeout=5000)
                check(True, "an empty source path gets an in-page warning")
                pg4.click("#md-ok")
                pg4.fill("#setup-source", str(ss4 / "nope"))
                pg4.click("#setup-create-run")
                pg4.wait_for_selector("#setup-step-run:not([hidden]) #setup-result .warn", timeout=20000)
                check(pg4.evaluate("document.getElementById('setup-retry').hidden") is False, "a refused source folder offers retry")
                pg4.click("#setup-retry")
                pg4.wait_for_selector("#setup-step-create:not([hidden])", timeout=5000)
                pg4.fill("#setup-source", str(src4))
                pg4.click("#setup-create-run")
                # the scan spawns node; the fingerprint pins 8688 entries, this scratch cache
                # has 1, so the honest outcome is a difference against the reference -- which
                # is also the check that the scan really reported facts back. It is stated as
                # information (.info), not as a warning about the user's install: the pinned
                # version is the builder's reference, not a claim about the user's game.
                pg4.wait_for_selector("#setup-step-run:not([hidden]) #setup-result .info", timeout=60000)
                check("深度事实条目" in pg4.inner_text("#setup-result"), "the scan's result is checked against the pinned fingerprint")
                check(pg4.evaluate("document.querySelectorAll('#setup-result .warn').length") == 0,
                      "a version difference is not dressed up as a hard warning")
                check(pg4.evaluate("document.getElementById('setup-result').textContent.includes('✓')") is True,
                      "the completed scan still reads as completed")
                check(pg4.evaluate("document.getElementById('setup-done').hidden") is False, "the wizard offers the way in after the scan")
                b4.close()

            facts = json.loads((cache4 / "create.json").read_text(encoding="utf-8"))
            check(facts.get("o_test_child", {}).get("depth") == {"mode": "y", "from": "o_test_child", "offset": 18},
                  f"the scanned Create depth is recorded ({facts.get('o_test_child')})")
            check(facts.get("o_test_child", {}).get("draw", {}).get("mode") == "self", "the scanned Draw mode is recorded")
            check("o_test_parent" not in facts, "objects with nothing to say are left out")

            st, s = call4("GET", "/api/setup")
            check(s["mode"] == "ready", "the scan completes the cache: the backend leaves degraded mode")
            check(s["sourceGml"] == 2, "the source tree is remembered and re-counted (Create_0 + Draw_0)")
            check(json.loads(scfg4.read_text(encoding="utf-8"))["sourceDir"] == str(src4), "the source dir persists to the config")
            st, r = call4("GET", "/api/rooms")
            check(st == 200, "the editor answers after the scan")

            # the escape hatch: no source tree on this machine. boot() is what re-reads the
            # reasons, so removing the file alone does not re-degrade a running server --
            # the skip route calls boot() itself, exactly as a restart would
            (cache4 / "create.json").unlink()
            st, r = call4("POST", "/api/setup/create", {"skip": True})
            check(st == 200 and r.get("skipped") is True and r["setup"]["mode"] == "ready",
                  "skipping writes the empty table and still lets the app in")
            check(json.loads((cache4 / "create.json").read_text(encoding="utf-8")) == {}, "the skipped table is empty, not absent")

            print("C4. 本机设置 on a working install (game update)")
            # 帮助 → 本机设置… is machine-level and must NOT cost the user their editor: it
            # opens the same dialog, dismissibly, and touches nothing on disk. Only a real
            # round (a completed step) rebuilds anything -- so an abandoned visit is free.
            before = (cache4 / "create.json").read_text(encoding="utf-8")
            with sync_playwright() as p5:
                b5 = p5.chromium.launch()
                pg5 = b5.new_page(viewport={"width": 1280, "height": 860})
                pg5.goto(base4)
                pg5.wait_for_selector("#options", timeout=60000)
                check(pg5.evaluate("document.getElementById('setup-dialog').open") is False,
                      "the install is healthy: the editor loads with no wizard")
                check(pg5.evaluate("svre.menu('help.setup')") is True, "the menu id is accepted")
                pg5.wait_for_selector("#setup-dialog[open]", timeout=10000)
                check(pg5.evaluate("document.getElementById('setup-step-win').hidden") is False,
                      "the by-hand visit starts at the data file (what a game update changes)")
                check(pg5.evaluate("document.getElementById('setup-close').hidden") is False,
                      "and it is dismissible: nothing is actually broken")
                pg5.keyboard.press("Escape")
                check(pg5.evaluate("document.getElementById('setup-dialog').open") is False,
                      "Esc closes it -- the editor is still there underneath")
                check(pg5.evaluate("document.getElementById('options') !== null") is True, "the editor never went away")
                b5.close()
            check((cache4 / "create.json").read_text(encoding="utf-8") == before,
                  "opening 本机设置 deletes nothing")

            # the round itself: nothing on disk is touched up front, so the old cache keeps
            # serving until a new extract lands
            st, r = call4("POST", "/api/setup/restart")
            check(st == 200, f"a round can be asked for over HTTP ({st})")
            st, s = call4("GET", "/api/setup")
            check(s["mode"] == "setup" and s["forced"] is True and s["reasons"] == [],
                  f"the backend is behind the wizard again with nothing actually broken ({s.get('mode')} / {s.get('reasons')})")
            st, r = call4("GET", "/api/rooms")
            check(st == 503, "and the editor's routes are closed while the round runs")

            # the round ends the way the wizard ends one: a step completes -> boot() -> healthy.
            # (a real extract also deletes the now-stale create.json when the round was asked
            # for; that half needs a real data.win, so only a real-data run covers it)
            st, r = call4("POST", "/api/setup/create", {"sourceDir": str(src4)})
            check(st == 202, "the scan starts")
            s = {"mode": "setup"}
            for _ in range(120):
                st, s = call4("GET", "/api/setup")
                if s["mode"] == "ready":
                    break
                time.sleep(0.5)
            check(s["mode"] == "ready" and s["forced"] is False, "a completed step ends the asked-for round")
            check(s["reasons"] == [], "and the reasons are empty, not just overridden")
            st, r = call4("GET", "/api/rooms")
            check(st == 200, "the editor answers again")
        finally:
            subprocess.run(f"taskkill /PID {server4.pid} /T /F", shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            shutil.rmtree(ss4, ignore_errors=True)

        print("C5. UTMT CLI: fetching one when the machine has none")
        # A clone has no vendor/utmt/ (gitignored: `npm run vendor:utmt` fills it) and a build
        # made without that step ships none either -- the extract then cannot run at all. This
        # serves a stand-in release zip over http (SVRE_UTMT_URL) and checks the whole path the
        # wizard's button drives: resolve -> refuse -> download + unpack + swap -> resolve again.
        ss5 = Path(tempfile.mkdtemp(prefix="svre-e2e-utmt-"))
        install5 = ss5 / "utmt"  # SVRE_UTMT_DIR, so the repo's own vendor/utmt is never touched
        (ss5 / "mod").mkdir()
        (ss5 / "mod" / "assets.json").write_text('{"sprites": {}, "objects": {}}', encoding="utf-8")
        (ss5 / "cache").mkdir()  # empty cache: the wizard opens on step 2, which carries the panel
        fakewin = ss5 / "fake.win"
        with fakewin.open("wb") as f:
            f.truncate(65 * 1024 * 1024)  # the endpoint's "is this Stoneshard's data file" gate
        with zipfile.ZipFile(ss5 / "release.zip", "w") as z:
            root = "UTMT_CLI_v0.9.2.0-Windows/"  # the release asset wraps its payload in a folder
            # a real (if unrelated) executable stands in for the CLI: the extract has to be
            # able to start it at all. What it then makes of a fake data file is not this
            # test's business -- it exits non-zero, which the run panel reports as a failure.
            z.writestr(root + "UndertaleModCli.exe", (Path(os.environ.get("SystemRoot", "C:/Windows")) / "System32" / "where.exe").read_bytes())
            z.writestr(root + "UndertaleModLib.dll", b"")
            z.writestr(root + "UndertaleModCli.runtimeconfig.json", "{}")
        scfg5 = ss5 / "svre.config.json"
        scfg5.write_text(json.dumps({"modDir": str(ss5 / "mod"), "assetsDir": str(ss5 / "cache"),
                                     "sourceDir": "", "vanillaWin": str(fakewin), "utmtCli": ""}), encoding="utf-8")
        base5 = f"http://localhost:{SETUP_UTMT_PORT}"

        def call5(method, path, body=None):
            req = urllib.request.Request(base5 + path, method=method,
                                         data=json.dumps(body).encode() if body is not None else None,
                                         headers={"Content-Type": "application/json"} if body is not None else {})
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    return r.status, json.loads(r.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                try:
                    return e.code, json.loads(e.read().decode("utf-8"))
                except json.JSONDecodeError:
                    return e.code, None

        class Quiet(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *a):  # the test output is not an access log
                pass

        srv5 = http.server.ThreadingHTTPServer(("127.0.0.1", UTMT_ZIP_PORT),
                                               functools.partial(Quiet, directory=str(ss5)))
        srv5.daemon_threads = True
        threading.Thread(target=srv5.serve_forever, daemon=True).start()
        env5 = {**os.environ, "SVRE_CONFIG": str(scfg5),
                "SVRE_UTMT_URL": f"http://127.0.0.1:{UTMT_ZIP_PORT}/release.zip",
                "SVRE_UTMT_DIR": str(install5)}
        server5 = subprocess.Popen("npx vite --port %d --strictPort" % SETUP_UTMT_PORT, cwd=ROOT, env=env5, shell=True,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
        try:
            for _ in range(120):
                try:
                    urllib.request.urlopen(f"{base5}/api/setup", timeout=1)
                    break
                except Exception:
                    time.sleep(0.5)

            st, s = call5("GET", "/api/setup")
            u = s["utmt"]
            check(u["cli"] is None and u["installed"] is False, f"no CLI on this machine ({u['cli']})")
            check(u["dir"] == str(install5), "the state says where a download would land")
            check(u["release"]["version"] == "0.9.2.0" and u["release"]["bytes"] > 0,
                  f"and which release it would fetch (v{u['release']['version']})")
            st, r = call5("POST", "/api/setup/extract", {"vanillaWin": str(fakewin)})
            check(st == 400 and "UndertaleModCli" in str(r.get("error", "")), "the extract refuses without one")

            with sync_playwright() as p6:
                b6 = p6.chromium.launch()
                pg6 = b6.new_page(viewport={"width": 1280, "height": 860})
                pg6.goto(base5)
                pg6.wait_for_selector("#setup-step-win:not([hidden])", timeout=60000)
                check("还没找到 UndertaleModCli.exe" in pg6.inner_text("#setup-utmt"),
                      "step 2 says the extract tool is missing before the user tries to extract")
                check("下载并安装" in pg6.inner_text("#setup-utmt-get"), "and offers to fetch it")
                pg6.click("#setup-utmt-get")
                pg6.wait_for_selector("#setup-utmt:has-text('已就绪')", timeout=60000)
                check(str(install5) in pg6.inner_text("#setup-utmt") and "0.9.2.0" in pg6.inner_text("#setup-utmt"),
                      "the panel reports the installed copy and its version")
                check(pg6.inner_text("#setup-utmt-get").startswith("重新下载"), "the button turns into an update")
                b6.close()

            check((install5 / "UndertaleModCli.exe").exists(), "the CLI landed where the state said it would")
            check((install5 / "UndertaleModLib.dll").exists() and (install5 / "UndertaleModCli.runtimeconfig.json").exists(),
                  "the whole runtime set came with it, not just the exe")
            check(json.loads((install5 / "svre-utmt.json").read_text(encoding="utf-8"))["version"] == "0.9.2.0",
                  "the download is marked with the release it came from")
            leftover = [p.name for p in install5.parent.iterdir() if p.name != install5.name and p.name != "mod"
                        and p.name != "cache" and p.name not in ("svre.config.json", "release.zip", "fake.win")]
            check(leftover == [], f"no staging leftovers next to it ({leftover})")

            st, s = call5("GET", "/api/setup")
            check(s["utmt"]["cli"] == str(install5 / "UndertaleModCli.exe") and s["utmtCli"] == s["utmt"]["cli"],
                  "resolveUtmtCli now finds the downloaded copy")
            check(s["utmt"]["installed"] is True and s["utmt"]["version"] == "0.9.2.0", "and knows what it is")
            st, r = call5("POST", "/api/setup/extract", {"vanillaWin": str(fakewin)})
            # the very request that was refused a moment ago now starts: the CLI gate is past
            check(st == 202, f"the same extract is accepted once the CLI is there ({r})")
            for _ in range(40):
                _, s5 = call5("GET", "/api/setup")
                if not s5["running"]:
                    break
                time.sleep(0.5)
            check(s5["running"] is False and s5["utmt"]["cli"] is not None,
                  "the run it started is over and the CLI is still resolved (the stand-in is not a real CLI)")
        finally:
            srv5.shutdown()
            subprocess.run(f"taskkill /PID {server5.pid} /T /F", shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            shutil.rmtree(ss5, ignore_errors=True)

        print("D. projects: open / switch / close (the welcome page's routes)")
        # A scratch config with NO project but a COMPLETE machine: assetsDir and sourceDir
        # point at this machine's real cache and source tree (machine-level facts, shared by
        # every project), so opening a folder lands straight in the editor -- which is what
        # makes the switch/reload protocol below observable.
        sd = Path(tempfile.mkdtemp(prefix="svre-e2e-proj-"))

        def abs_key(key):
            v = CFG.get(key, "")
            return str(v if os.path.isabs(v) else (ROOT / v).resolve())

        scfgd = sd / "svre.config.json"
        scfgd.write_text(json.dumps({"modDir": "", "assetsDir": abs_key("assetsDir"),
                                     "sourceDir": abs_key("sourceDir"), "vanillaWin": abs_key("vanillaWin"),
                                     "utmtCli": ""}), encoding="utf-8")
        base6 = f"http://localhost:{PROJ_PORT}"
        cfgd = lambda: json.loads(scfgd.read_text(encoding="utf-8"))

        def call6(method, path, body=None, timeout=15):
            req = urllib.request.Request(base6 + path, method=method,
                                         data=json.dumps(body).encode() if body is not None else None,
                                         headers={"Content-Type": "application/json"} if body is not None else {})
            try:
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    return r.status, json.loads(r.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                try:
                    return e.code, json.loads(e.read().decode("utf-8"))
                except json.JSONDecodeError:
                    return e.code, None

        # D3 needs a download that never finishes: it parks utmtState.running so the switch
        # guard can be tested without racing a real job. The URL has to be in the server's
        # environment from the start (the process gets a copy of it, not a live view).
        hold = threading.Event()

        class Hold(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):  # blocks until the test releases it (the timeout is a guard)
                hold.wait(60)
                self.send_response(404)
                self.end_headers()

        srv6 = http.server.ThreadingHTTPServer(("127.0.0.1", SLOW_ZIP_PORT), Hold)
        srv6.daemon_threads = True
        threading.Thread(target=srv6.serve_forever, daemon=True).start()
        env6 = {**os.environ, "SVRE_CONFIG": str(scfgd),
                "SVRE_UTMT_URL": f"http://127.0.0.1:{SLOW_ZIP_PORT}/never.zip"}
        server6 = subprocess.Popen("npx vite --port %d --strictPort" % PROJ_PORT, cwd=ROOT, env=env6, shell=True,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
        try:
            for _ in range(120):
                try:
                    urllib.request.urlopen(f"{base6}/api/setup", timeout=1)
                    break
                except Exception:
                    time.sleep(0.5)

            st, s = call6("GET", "/api/setup")
            check(s["mode"] == "welcome" and s["reasons"] == [] and s["project"] is None,
                  f"no project + a healthy machine is still welcome mode ({s.get('mode')} / {s.get('reasons')})")
            st, p = call6("GET", "/api/projects")
            check(st == 200 and p["current"] is None and p["recent"] == [], f"empty recent list ({p})")

            # not a mod tree: one confirmation's worth of 409, and nothing written
            bare = sd / "BareFolder"
            bare.mkdir()
            st, r = call6("POST", "/api/projects/open", {"path": str(bare)})
            check(st == 409 and (r.get("detail") or {}).get("code") == "unfamiliar", f"an empty folder warns first ({st} {r})")
            check(not (bare / "assets.json").exists(), "the refused open wrote nothing")

            # a folder name that cannot become `namespace X;`: a hard 400, force or not. This
            # check runs BEFORE the familiarity one -- it is the error the user cannot fix
            # from inside the app, so it must be the one that comes back.
            bad = sd / "my mod!"
            bad.mkdir()
            st, r = call6("POST", "/api/projects/open", {"path": str(bad), "force": True})
            check(st == 400, f"a non-identifier basename is refused even with force ({st} {str(r.get('error'))[:60]})")
            check(not (bad / "assets.json").exists(), "and it wrote nothing either")

            proj = sd / "StoneValley"
            proj.mkdir()
            st, r = call6("POST", "/api/projects/open", {"path": str(proj), "force": True})
            check(st == 200 and r["ok"] is True, f"force opens the unfamiliar folder ({st} {r})")
            check((proj / "rooms").is_dir() and (proj / "Sprites").is_dir() and (proj / "Codes").is_dir()
                  and (proj / "assets.json").is_file(), "the skeleton is created")
            check(sorted(r.get("created", [])) == ["Codes/", "Sprites/", "assets.json", "rooms/"],
                  f"the reply names what it made ({r.get('created')})")
            check(r["setup"]["mode"] == "ready" and r["setup"]["project"]["name"] == "StoneValley",
                  "opened: the machine was already fine, so this lands in the editor")
            check(cfgd()["modDir"] == str(proj), "modDir persists to the scratch config")
            check([x["name"] for x in cfgd()["recent"]] == ["StoneValley"], "and the project is in the recent list")
            st, r = call6("GET", "/api/rooms")
            check(st == 200, "the routes open up for the new project")

            marker = proj / "rooms" / "keep.txt"
            marker.write_text("x", encoding="utf-8")
            st, r = call6("POST", "/api/projects/open", {"path": str(proj)})
            check(st == 200 and r["created"] == [], f"re-opening needs no force and creates nothing ({r.get('created')})")
            check(marker.read_text(encoding="utf-8") == "x", "an existing project is left untouched")

            second = sd / "SecondMod"
            second.mkdir()
            st, r = call6("POST", "/api/projects/open", {"path": str(second), "force": True})
            st, p = call6("GET", "/api/projects")
            check([x["name"] for x in p["recent"]] == ["SecondMod", "StoneValley"], f"newest first ({[x['name'] for x in p['recent']]})")
            check(p["current"]["name"] == "SecondMod", "current follows the switch")
            call6("POST", "/api/projects/open", {"path": str(proj)})
            st, p = call6("GET", "/api/projects")
            check([x["name"] for x in p["recent"]] == ["StoneValley", "SecondMod"], "re-opening moves it to the front")

            # a folder that vanished behind the app's back: the entry stays, greyed out (only
            # an explicit 移除 drops it -- the app never guesses that a folder is gone for good)
            shutil.rmtree(second, ignore_errors=True)
            st, p = call6("GET", "/api/projects")
            gone = [x for x in p["recent"] if x["name"] == "SecondMod"]
            check(len(gone) == 1 and gone[0]["exists"] is False, f"a deleted folder is listed as missing ({gone})")

            st, r = call6("POST", "/api/projects/forget", {"path": str(second)})
            check(st == 200, f"forget answers ({st})")
            st, p = call6("GET", "/api/projects")
            check([x["name"] for x in p["recent"]] == ["StoneValley"], "the forgotten entry is gone")
            check(p["current"]["name"] == "StoneValley", "the current project is untouched")

            # forgetting the OPEN project is a list operation, never a close
            call6("POST", "/api/projects/forget", {"path": str(proj)})
            st, p = call6("GET", "/api/projects")
            check(p["recent"] == [] and p["current"]["name"] == "StoneValley",
                  "forgetting the open project empties the list but leaves it open")
            st, s = call6("GET", "/api/setup")
            check(s["mode"] == "ready", "and the editor is still there")

            print("D2. bad paths")
            st, r = call6("POST", "/api/projects/open", {"path": "C:\\"})
            check(st == 400, f"a drive root is refused ({st} {str(r.get('error'))[:40]})")
            st, r = call6("POST", "/api/projects/open", {"path": ""})
            check(st == 400, f"an empty path is refused ({st})")
            afile = sd / "a.txt"
            afile.write_text("x", encoding="utf-8")
            st, r = call6("POST", "/api/projects/open", {"path": str(afile)})
            check(st == 400 and "文件" in str(r.get("error", "")), f"a plain file is refused ({st} {str(r.get('error'))[:40]})")
            fresh = sd / "nope" / "deep" / "NewMod"
            st, r = call6("POST", "/api/projects/open", {"path": str(fresh)})
            check(st == 409 and (r.get("detail") or {}).get("code") == "unfamiliar", "a brand-new nested path warns too")
            st, r = call6("POST", "/api/projects/open", {"path": str(fresh), "force": True})
            check(st == 200 and fresh.is_dir(), f"force creates the whole path (新建项目) ({st})")

            print("D3. a project cannot be switched out from under a running job")
            st, r = call6("POST", "/api/setup/utmt")
            check(st == 202, f"the download starts ({st} {r})")
            running = False
            for _ in range(20):
                _, s6 = call6("GET", "/api/setup")
                if s6["utmt"]["running"]:
                    running = True
                    break
                time.sleep(0.2)
            check(running, "the backend reports the download as running")
            st, r = call6("POST", "/api/projects/open", {"path": str(second)})
            check(st == 409 and "UTMT" in str(r.get("error", "")), f"switching is refused while it runs ({st} {r})")
            st, r = call6("POST", "/api/projects/close")
            check(st == 409, f"closing is refused too ({st})")
            hold.set()  # let the request answer (404): the job fails, the guard lifts
            for _ in range(60):
                _, s6 = call6("GET", "/api/setup")
                if not s6["utmt"]["running"]:
                    break
                time.sleep(0.5)
            check(s6["utmt"]["running"] is False, "the job is over")
            check(s6["mode"] == "ready" and s6["project"]["name"] == "NewMod", "and the project never changed")

            print("D4. the welcome page and the switch, in two browser tabs")
            # back to nothing open, so the page starts on the welcome screen
            st, r = call6("POST", "/api/projects/close")
            check(st == 200, f"close answers ({st})")
            st, s = call6("GET", "/api/setup")
            check(s["mode"] == "welcome" and s["project"] is None, f"back to welcome ({s.get('mode')})")
            check([x["name"] for x in cfgd()["recent"]] == ["NewMod"], "closing does not forget the project")
            st, r = call6("GET", "/api/rooms")
            check(st == 503, "and the routes close again")
            st, p = call6("GET", "/api/projects")
            check(p["current"] is None and [x["name"] for x in p["recent"]] == ["NewMod"],
                  f"the recent list is still there with nothing open ({p})")

            with sync_playwright() as p7:
                b7 = p7.chromium.launch()
                pga = b7.new_page(viewport={"width": 1280, "height": 860})
                pgb = b7.new_page(viewport={"width": 1280, "height": 860})
                pga.goto(base6)
                pgb.goto(base6)
                pga.wait_for_selector("#welcome:not([hidden])", timeout=60000)
                pgb.wait_for_selector("#welcome:not([hidden])", timeout=60000)
                check(pga.evaluate("document.querySelectorAll('#wc-recent-list .wc-row').length") == 1,
                      "the recent list is rendered on the welcome page")
                check(pga.inner_text("#wc-machine").startswith("✓"), "and the machine strip is green on a ready machine")
                pgb.evaluate("window.__tab = 'B'")  # a marker a reload would wipe
                # A opens a project; the server emits {type:"project"} and BOTH tabs reload
                pga.evaluate("void svre.openProject('%s')" % str(proj).replace("\\", "\\\\"))
                pga.wait_for_selector("#options", timeout=60000)
                # the top bar is visible from the first paint (it is plain HTML; only the
                # welcome page's body class hides it), while the title is seated after
                # /api/setup answers. Wait for the claim being tested, not for the chrome.
                pga.wait_for_function("() => document.title.includes('StoneValley')", timeout=60000)
                check("StoneValley" in pga.title(), f"the title names the project ({pga.title()})")
                # the editor chrome is up before /api/rooms has answered, so wait for the
                # room list itself -- the bar alone would let this race the fetch
                try:
                    pga.wait_for_function(
                        "document.querySelector('#room-select optgroup')?.label === 'StoneValley'", timeout=60000)
                    grouped = True
                except Exception:
                    grouped = False
                check(grouped, "A's room dropdown is grouped under the project name")
                pgb.wait_for_selector("#options", timeout=60000)
                check(pgb.evaluate("window.__tab === undefined") is True, "B reloaded itself: the marker is gone")
                check(pgb.evaluate("location.search") == "", f"and the reload dropped the old query ({pgb.evaluate('location.search')})")
                try:
                    pgb.wait_for_function(
                        "document.querySelector('#room-select optgroup')?.label === 'StoneValley'", timeout=60000)
                    grouped_b = True
                except Exception:
                    grouped_b = False
                check(grouped_b, "B sees the same project without being told")
                b7.close()

            st, s = call6("GET", "/api/setup")
            check(s["mode"] == "ready" and s["project"]["exists"] is True, "the server agrees the project is open")
        finally:
            hold.set()
            if srv6 is not None:
                srv6.shutdown()
            subprocess.run(f"taskkill /PID {server6.pid} /T /F", shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            shutil.rmtree(sd, ignore_errors=True)
    finally:
        subprocess.run(f"taskkill /PID {server.pid} /T /F", shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shutil.rmtree(scratch, ignore_errors=True)

    print("\nFAILED: %d" % len(failures) if failures else "\nall passed")
    sys.exit(1 if failures else 0)


main()
