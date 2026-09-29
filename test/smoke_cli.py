"""CLI smoke test: scratch mod copy + server on :5181, drive cli/svre.py as a subprocess.

    python test/smoke_cli.py
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
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CFG = json.loads((ROOT / "svre.config.json").read_text(encoding="utf-8"))
PORT = 5181
SERVER = f"http://localhost:{PORT}"
CLI = ROOT / "cli" / "svre.py"

failures = []


def check(cond, what):
    print(("  ok   " if cond else "  FAIL ") + what)
    if not cond:
        failures.append(what)


def svre(*argv, expect_fail=False):
    r = subprocess.run(
        [sys.executable, str(CLI), *argv],
        capture_output=True, text=True, encoding="utf-8",
        env={**os.environ, "SVRE_SERVER": SERVER},
        cwd=ROOT,
    )
    if expect_fail:
        return r.returncode != 0, r.stderr.strip()
    if r.returncode != 0:
        return False, r.stderr.strip()
    out = r.stdout.strip()
    try:
        return True, json.loads(out)
    except Exception:
        return True, out


def main():
    scratch = Path(tempfile.mkdtemp(prefix="svre-cli-"))
    (scratch / "Codes").mkdir()
    # import turns a legacy generator-era Codes/r_*.gml artifact into a project; the
    # golden fixture stands in for one (the mod's own rooms live in rooms/*.compiled.json)
    golden1 = (ROOT / "test" / "golden" / "r_sv_hut_inside1.json").read_bytes()
    (scratch / "Codes" / "r_sv_hut_inside1.gml").write_bytes(golden1)
    shutil.copytree(Path(CFG["modDir"]) / "Sprites", scratch / "Sprites")
    shutil.copy2(Path(CFG["modDir"]) / "assets.json", scratch / "assets.json")

    env = {**os.environ, "SVRE_MOD_DIR": str(scratch)}
    server = subprocess.Popen(f"npx vite --port {PORT} --strictPort", cwd=ROOT, env=env, shell=True,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    try:
        for _ in range(120):
            try:
                urllib.request.urlopen(f"{SERVER}/api/rooms", timeout=1)
                break
            except Exception:
                time.sleep(0.5)

        ok, out = svre("rooms")
        check(ok and "r_sv_hut_inside1" in out, "rooms lists the mod's rooms")

        ok, out = svre("describe", "r_sv_hut_inside1", expect_fail=True)
        check(ok and "no project" in out, "describe before import says so")

        ok, out = svre("import", "r_sv_hut_inside1", "--by", "smoke")
        check(ok and out.get("base"), f"import ({out})")
        # import turns the legacy artifact into the project's compiled snapshot, verbatim
        snap = scratch / "rooms" / "r_sv_hut_inside1.compiled.json"
        check(snap.exists() and snap.read_bytes() == golden1, "import writes rooms/<name>.compiled.json byte-identical")

        ok, out = svre("describe", "r_sv_hut_inside1")
        check(ok and "instances" in json.dumps(out), "describe prints the summary")

        ok, out = svre("query", "r_sv_hut_inside1", "--object", "o_position_starter")
        check(ok and isinstance(out, list) and len(out) >= 1, f"query starters ({len(out)})")

        ok, out = svre("grid", "r_sv_hut_inside1", "0,0,12,8")
        check(ok and isinstance(out, str) and "\n" in out, "grid region prints ASCII")

        # apply: move the first starter by one cell
        starter = out and svre("query", "r_sv_hut_inside1", "--object", "o_position_starter")[1][0]
        iid, x, y = starter["instance_id"], starter["x"], starter["y"]
        ops = Path(scratch) / "ops.json"
        ops.write_text(json.dumps([{"op": "set", "id": iid, "set": {"x": x + 26}, "expect": {"x": x}}]), encoding="utf-8")
        ok, out = svre("apply", "r_sv_hut_inside1", "--ops", str(ops), "--label", "挪 starter", "--by", "smoke")
        check(ok and out.get("rev") == 2, f"apply ok (rev {out.get('rev')}, findings: {len(out.get('findings', []))})")

        ok, out = svre("apply", "r_sv_hut_inside1", "--ops", str(ops), "--by", "smoke", expect_fail=True)
        check(ok and "409" in out, "replaying the same ops now conflicts (stale expect)")

        ok, out = svre("undo", "r_sv_hut_inside1", "--by", "smoke")
        check(ok, "undo")
        ok, out = svre("redo", "r_sv_hut_inside1", "--by", "smoke")
        check(ok, "redo")

        ok, out = svre("note", "r_sv_hut_inside1", "130", "156", "smoke 便签")
        check(ok and out.get("id"), "note added")
        ok, out = svre("notes", "r_sv_hut_inside1")
        check(ok and any(n["text"] == "smoke 便签" for n in out), "notes list shows it")
        nid = [n for n in out if n["text"] == "smoke 便签"][0]["id"]
        ok, _ = svre("note", "r_sv_hut_inside1", "rm", nid)
        check(ok, "note removed")

        ok, out = svre("compile", "r_sv_hut_inside1")
        check(ok and out.get("file", "").endswith("r_sv_hut_inside1.compiled.json"), f"compile -> {out.get('file')}")

        # the generated C#: the const's value is the snapshot byte for byte (the snapshot
        # itself legitimately differs from the golden by the apply/redo above).
        # read as BYTES: the snapshots are CRLF-styled and read_text would eat the \r
        rcs = scratch / f"{scratch.name}.Rooms.g.cs"
        rcsraw = rcs.read_bytes() if rcs.exists() else b""
        check(b'public const string r_sv_hut_inside1 = """' in rcsraw
              and b"Msl.AddRoomJson(r_sv_hut_inside1);" in rcsraw, "Rooms.g.cs has the const + RegisterAll call")
        m = re.search(rb'public const string r_sv_hut_inside1 = ("{3,})\n(.*?)\n\1;', rcsraw, re.S)
        check(m is not None and m.group(2) == snap.read_bytes(), "the const's value is the snapshot byte for byte")
        # self-heal: tamper the generated file, recompile, it comes back
        rcs.write_bytes(rcsraw + b"\n// tampered")
        ok, out = svre("compile", "r_sv_hut_inside1")
        check(ok and out.get("roomsCsSynced") is True and b"tampered" not in rcs.read_bytes(),
              "Rooms.g.cs self-heals on compile")

        ok, out = svre("changes", "r_sv_hut_inside1", "--since", "1")
        check(ok and out.get("head") >= 2, "changes lists the log")

        png = Path(scratch) / "render.png"
        ok, out = svre("render", "r_sv_hut_inside1", str(png), "--grid", "--labels", "--zoom", "2")
        check(ok and png.exists() and png.stat().st_size > 10000, f"render wrote {png.name} ({png.stat().st_size if png.exists() else 0} bytes)")

        ok, out = svre("vanilla", "house01inside")
        check(ok and isinstance(out, list) and any(r["name"].startswith("r_house01inside") for r in out), "vanilla search finds bases")

        ok, out = svre("create", "r_smoke_new", "--base", "r_house01inside_Child_2", "--keep", "controllers")
        check(ok and out.get("name") == "r_smoke_new", "create a skeleton room on a vanilla base")
        ok, out = svre("describe", "r_smoke_new")
        names = json.dumps(out)
        check(ok and "r_smoke_new" in names, "the new room describes")

        print("mod assets: manifest -> editor defs + generated C#")
        with urllib.request.urlopen(f"{SERVER}/api/mod-assets", timeout=5) as r:
            ma = json.loads(r.read())
        sp = ma["sprites"].get("s_sv_house01", {})
        check(sp.get("oy") == 234 and len(sp.get("frames", [])) == 2, f"mod sprite def incl. the manifest origin override ({sp.get('w')}x{sp.get('h')}, oy={sp.get('oy')})")
        check(ma["objects"].get("o_sv_house01", {}).get("sprite") == "s_sv_house01"
              and ma["objects"]["o_sv_house01"].get("parent") == "c_barrierFade", "object defs come from assets.json")
        check(ma["objects"].get("o_sv_hut", {}).get("parent") == "o_globalmap_herbalistHouse", "vanilla-sprite object from assets.json")
        check(ma.get("warnings") == [], f"manifest validates clean ({ma.get('warnings')})")
        with urllib.request.urlopen(f"{SERVER}/mod-assets/pages/0.png", timeout=5) as r:
            sig = r.read(8)
        check(sig[:4] == b"\x89PNG", "pseudo page serves a PNG")
        gen = scratch / f"{scratch.name}.Assets.g.cs"  # the generated file takes the mod dir's basename
        gentext = gen.read_text(encoding="utf-8") if gen.exists() else ""
        check('Msl.AddObject("o_sv_house01"' in gentext and "MarginTop = 29" in gentext, "the scan self-healed the generated C# into the mod dir")
        ok, out = svre("assets")
        check(ok and "o_sv_house01" in out, "cli assets lists the manifest objects")
        mf = json.loads((scratch / "assets.json").read_text(encoding="utf-8"))
        mf["objects"]["o_sv_hut"]["note"] = "changed"
        (scratch / "assets.json").write_text(json.dumps(mf, ensure_ascii=False, indent=2), encoding="utf-8")
        ok, out = svre("assets", "sync")
        check(ok and out.get("synced") is True and "changed" in gen.read_text(encoding="utf-8"), "sync rewrites the .g.cs when the manifest changed")
    finally:
        subprocess.run(f"taskkill /PID {server.pid} /T /F", shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shutil.rmtree(scratch, ignore_errors=True)

    print("\nFAILED: %d" % len(failures) if failures else "\nall passed")
    sys.exit(1 if failures else 0)


main()
