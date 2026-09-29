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
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
CFG = json.loads((ROOT / "svre.config.json").read_text(encoding="utf-8"))
ROOM = "r_sv_hut_inside2"
PORT = 5179
BASE = f"http://localhost:{PORT}"

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
            t0 = pg.evaluate("svre.pickTarget()")
            check(t0 is not None, "pickTarget found a drawn instance")
            # center the target at a known zoom so 30 screen px == 15 world px -> snaps to 26
            wp = pg.evaluate(f"(() => {{ const r = svre.doc.room; for (const L of r.layers) for (const i of (L.layer_data.instances ?? [])) if (i.instance_id === {t0['id']}) return {{x: i.x, y: i.y}}; }})()")
            pg.evaluate(f"svre.focus({wp['x']}, {wp['y']}, 2)")
            pg.wait_for_timeout(150)
            t = pg.evaluate("svre.pickTarget()")
            box = pg.locator("#stage").bounding_box()
            sx, sy = box["x"] + t["x"], box["y"] + t["y"]
            pg.mouse.click(sx, sy)
            pg.wait_for_timeout(200)
            sel = pg.evaluate("svre.selection")
            check(len(sel) == 1, f"click selects one instance ({sel})")
            tid = sel[0]
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
                right0 = g["box"]["x"] + g["box"]["w"]
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
                check(abs(mir["x"] - srcr["x"]) <= 26, "x may shift to keep the far edge pinned (centred origins)")
                grew = (mir["scale_x"] - srcr["scale_x"]) * obj_w
                # the moving edge snaps to the grid: nearest cell edge to (start + 30 world px)
                expected = round((right0 + 30) / 26) * 26 - right0
                check(abs(grew - expected) < 1e-3 and expected >= 26, f"east drag grew the box by one snapped cell ({grew}px)")
                pg.keyboard.press("Control+z")
                pg.wait_for_timeout(500)
                st, doc7 = call("GET", f"/api/doc/{ROOM}")
                check(find_inst(doc7, sel[0])["scale_x"] == srcr["scale_x"], "Ctrl+Z undid the resize on the server")

            print("resize snaps whatever the sprite frame")
            # s_gray is 5x5 -- a frame that is not a multiple of 26. The snap unit used to
            # be derived from the frame and fell back to 1px for these, so the 吸附 toggle
            # did nothing; now the edge always snaps to the grid, Alt frees it
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
                        edge = g0["box"]["x"] + mir["scale_x"] * g0["lb"]["w"]
                        check(abs(edge / 26 - round(edge / 26)) < 1e-6 and edge > right0,
                              f"snap on: the dragged edge lands on a cell line ({right0} -> {edge})")
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
                        edge = g0["box"]["x"] + mir["scale_x"] * g0["lb"]["w"]
                        check(abs(edge - round(right0 + 30)) < 1, f"Alt frees the edge to the raw pixel ({edge})")
                        pg.keyboard.press("Control+z")
                        pg.wait_for_timeout(500)
                        pg.keyboard.press("Escape")
                st, r = call("POST", f"/api/doc/{ROOM}/apply", {
                    "by": "agent-test",
                    "ops": [{"op": "delete", "id": gid, "expect": {"object_definition": "o_speech_trigger"}}]})
                check(st == 200, "non-cell box removed again")
                pg.evaluate("svre.focus(364, 338, 2)")  # back over the room for the later fixed-coordinate steps
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
            pg.click(".tabs button[data-tab=palette]")
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

            print("palette placement")
            pg.click(".tabs button[data-tab=palette]")
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
            p0 = pg.evaluate(f"svre.screen({spot[0] * 26 + 4}, {spot[1] * 26 + 4})")
            p1 = pg.evaluate(f"svre.screen({(spot[0] + 2) * 26 - 4}, {(spot[1] + 2) * 26 - 4})")
            pg.mouse.move(box["x"] + p0["x"], box["y"] + p0["y"])
            pg.mouse.down()
            pg.mouse.move(box["x"] + p1["x"], box["y"] + p1["y"], steps=5)
            pg.mouse.up()
            pg.wait_for_timeout(700)
            st, d1 = call("GET", f"/api/doc/{ROOM}")
            stamps = {(i["x"] // 26, i["y"] // 26) for L in d1["room"]["layers"] for i in L["layer_data"].get("instances", []) if i["object_definition"] == "o_hut_wall"}
            newcells = stamps - taken
            check(len(newcells) == 4, f"painted a 2x2 span ({sorted(newcells)})")
            lay = next((L["layer_name"] for L in d1["room"]["layers"] for i in L["layer_data"].get("instances", []) if (i["x"] // 26, i["y"] // 26) == spot and i["object_definition"] == "o_hut_wall"), None)
            check(lay == coll_name, f"stamps landed in the collision layer ({lay})")
            check(d1["log"][-1]["label"] == "涂刷碰撞 4 格", f"paint commit labelled ({d1['log'][-1]['label']})")
            pg.keyboard.down("Alt")
            pg.mouse.move(box["x"] + p0["x"], box["y"] + p0["y"])
            pg.mouse.down()
            pg.mouse.move(box["x"] + p1["x"], box["y"] + p1["y"], steps=5)
            pg.mouse.up()
            pg.keyboard.up("Alt")
            pg.wait_for_timeout(700)
            st, d2 = call("GET", f"/api/doc/{ROOM}")
            stamps2 = {(i["x"] // 26, i["y"] // 26) for L in d2["room"]["layers"] for i in L["layer_data"].get("instances", []) if i["object_definition"] == "o_hut_wall"}
            check(stamps2 == taken, "Alt+drag erased the painted span")

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
            pg.keyboard.press("Control+z")
            pg.wait_for_timeout(600)
            st, d7 = call("GET", f"/api/doc/{ROOM}")
            arr7 = [i["instance_id"] for i in next(L for L in d7["room"]["layers"] if L["layer_name"] == coll_name)["layer_data"]["instances"]]
            check(arr7 == arr, "Ctrl+Z restores the layer order")

            print("compile from the page")
            pg.keyboard.press("Control+s")
            pg.wait_for_timeout(800)
            st, doc7 = call("GET", f"/api/doc/{ROOM}")
            disk = target.read_bytes().decode("utf-8")
            check(doc7["dirty"] is False, "compiled: no longer dirty")
            check(obj in disk, f"compiled file contains {obj}")

            check(not errors, f"no page errors {errors}")
            browser.close()
    finally:
        subprocess.run(f"taskkill /PID {server.pid} /T /F", shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shutil.rmtree(scratch, ignore_errors=True)

    print("\nFAILED: %d" % len(failures) if failures else "\nall passed")
    sys.exit(1 if failures else 0)


main()
