#!/usr/bin/env python3
"""svre -- the agent-facing command line of sv-room-editor.

Talks to the dev server (npm run dev, default http://localhost:5178), which owns every
room project. Everything an agent can do to a room goes through here; a human looking at
the same room in a browser sees these changes land (and you see theirs via `changes`).

    python cli/svre.py rooms                        what rooms exist, what state they're in
    python cli/svre.py import r_foo                 turn a legacy Codes/r_foo.gml into a project
    python cli/svre.py create r_bar --base r_house01inside [--keep controllers]
    python cli/svre.py describe r_foo               summary + layers + links + problems
    python cli/svre.py lint r_foo                   rule findings (unknown objects, leaks, ...)
    python cli/svre.py grid r_foo [x0,y0,x1,y1]     ASCII map of the 26px cell grid
    python cli/svre.py query r_foo [--object o_] [--rect x0,y0,x1,y1] [--cell cx,cy] [--id N]
    python cli/svre.py apply r_foo --ops ops.json [--label "..."] [--note "..."] [--by name]
    python cli/svre.py undo r_foo / redo r_foo      per-author; --by picks whose
    python cli/svre.py changes r_foo [--since N]    log entries + undone revs since N
    python cli/svre.py compile r_foo [--force]      write rooms/<name>.compiled.json + <Mod>.Rooms.g.cs
    python cli/svre.py adopt r_foo                  log an outside edit of the compiled snapshot
    python cli/svre.py notes r_foo                  list notes
    python cli/svre.py note r_foo X Y "text"        leave a note at a position
    python cli/svre.py note rm r_foo ID             remove one
    python cli/svre.py select r_foo ID [ID...]      show others what you're looking at
    python cli/svre.py assets                       the mod asset manifest: objects, sprites, warnings
    python cli/svre.py assets sync                  rescan + rewrite <Mod>.Assets.g.cs if stale
    python cli/svre.py render r_foo out.png [--zoom 2] [--focus x,y] [--grid] [--labels]
    python cli/svre.py serve                        start the dev server (if not running)

Ops vocabulary for apply (JSON array; instance ids are the room JSON's instance_id):

    {"op": "add",     "layer": "Instances", "inst": {"object_definition": "o_chest", "x": 390, "y": 390}}
    {"op": "delete",  "id": 100234}
    {"op": "set",     "id": 100234, "set": {"x": 416, "creation_code": "..."}, "expect": {"x": 390}}
    {"op": "relayer", "id": 100234, "layer": "ForegroundInstances"}
    {"op": "room",    "set": {"width": 1300}, "expect": {"width": 1040}}
    {"op": "layer",   "layer": "Instances", "set": {"is_visible": true}}

`expect` is optimistic concurrency: the op applies only if the target still looks like
that. Omit it and the server pins it to the current state. A 409 tells you what changed
under you -- re-query and redo, don't force.

Instance fields: x, y, scale_x, scale_y, rotation, color (AABBGGRR int), image_index,
image_speed, creation_code, pre_create_code, object_definition. New instances only need
object_definition + x + y; the rest default (scale 1, color white, frame 0).

Environment: SVRE_SERVER overrides the server URL (default http://localhost:5178).
Exit code is 1 with the server's error message on any 4xx/5xx.
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER = os.environ.get("SVRE_SERVER", "http://localhost:5178")

# the console codepage is not always UTF-8 (cp936 on zh-CN Windows); agents read our output
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def call(method, path, body=None):
    req = urllib.request.Request(
        SERVER + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"} if body is not None else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode("utf-8")
            ct = r.headers.get("Content-Type", "")
            return json.loads(raw) if raw and ct.startswith("application/json") else raw
    except urllib.error.HTTPError as e:
        try:
            data = json.loads(e.read().decode("utf-8"))
        except Exception:
            data = {}
        msg = data.get("error", e.reason)
        detail = data.get("detail")
        print(f"error {e.code}: {msg}", file=sys.stderr)
        if detail is not None:
            print(json.dumps(detail, ensure_ascii=False, indent=2), file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError:
        print(f"cannot reach {SERVER} -- start the dev server first: python cli/svre.py serve", file=sys.stderr)
        sys.exit(1)


def out(data):
    if isinstance(data, str):
        print(data)
    else:
        print(json.dumps(data, ensure_ascii=False, indent=2))


def serve():
    if shutil_which("npx") is None:
        print("npx not on PATH", file=sys.stderr)
        sys.exit(1)
    try:
        urllib.request.urlopen(SERVER + "/api/rooms", timeout=2)
        print(f"already running at {SERVER}")
        return
    except Exception:
        pass
    port = urllib.parse.urlparse(SERVER).port or 5178
    proc = subprocess.Popen(
        f"npx vite --port {port} --strictPort", cwd=ROOT, shell=True,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
    )
    for _ in range(120):
        try:
            urllib.request.urlopen(SERVER + "/api/rooms", timeout=1)
            print(f"serving at {SERVER} (pid {proc.pid}); the UI is at {SERVER}/")
            return
        except Exception:
            time.sleep(0.5)
    print("server did not come up in 60s", file=sys.stderr)
    sys.exit(1)


def shutil_which(name):
    from shutil import which
    return which(name)


def render(args):
    """Screenshot the room canvas through a headless browser (needs playwright)."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("render needs playwright: pip install playwright && playwright install chromium", file=sys.stderr)
        sys.exit(1)
    name, png = args[0], args[1]
    zoom = float(arg_value(args, "--zoom", "2"))
    focus = arg_value(args, "--focus", None)
    params = [f"room={urllib.parse.quote(name)}", "render=1"]
    for flag, key in [("--grid", "grid"), ("--labels", "grid"), ("--collision", "collision"),
                      ("--hidden", "hidden"), ("--markers", "markers"), ("--notes", "notes")]:
        if flag in args:
            params.append(f"{key}=1")
    labels = "--labels" in args
    if focus:
        params.append(f"focus={focus}")
        params.append(f"zoom={zoom}")
    else:
        params.append(f"zoom={zoom}")
    url = f"{SERVER}/?{'&'.join(params)}"
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 1600, "height": 1000})
        pg.goto(url)
        pg.wait_for_function("window.svreReady === true", timeout=120000)
        pg.wait_for_timeout(300)
        pg.locator("#stage canvas").screenshot(path=png)
        b.close()
    print(png)


def arg_value(args, flag, default):
    return args[args.index(flag) + 1] if flag in args else default


def main():
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help", "help"):
        print(__doc__)
        return
    cmd, rest = args[0], args[1:]

    if cmd == "serve":
        serve()
    elif cmd == "rooms":
        for r in call("GET", "/api/rooms"):
            marks = []
            if not r["hasProject"]:
                marks.append("no project (import it)")
            if r["dirty"]:
                marks.append("uncompiled changes")
            if r["drift"]:
                marks.append("DRIFT: compiled file changed outside")
            if r["generatedBy"]:
                marks.append(f"generator: {', '.join(r['generatedBy'])}")
            print(f"{r['name']:<40} {'; '.join(marks)}")
    elif cmd == "import":
        out(call("POST", "/api/import", {"name": rest[0], "base": arg_value(rest, "--base", None), "by": arg_value(rest, "--by", "agent")}))
    elif cmd == "create":
        base = arg_value(rest, "--base", None)
        if base is None:
            print("create needs --base <vanilla room> (find one with: svre.py vanilla <query>)", file=sys.stderr)
            sys.exit(1)
        out(call("POST", "/api/create", {
            "name": rest[0], "base": base,
            "keep": arg_value(rest, "--keep", "all"), "by": arg_value(rest, "--by", "agent"),
        }))
    elif cmd == "vanilla":
        out(call("GET", "/api/vanilla?q=" + urllib.parse.quote(rest[0] if rest else "")))
    elif cmd in ("describe", "lint", "grid", "query", "changes", "selection"):
        name = rest[0]
        if cmd == "grid" and len(rest) > 1:
            out(call("GET", f"/api/doc/{name}/grid?region={urllib.parse.quote(rest[1])}"))
        elif cmd == "query":
            qs = {}
            for flag, key in [("--object", "object"), ("--layer", "layer"), ("--rect", "rect"),
                              ("--cell", "cell"), ("--id", "id"), ("--limit", "limit")]:
                if flag in rest:
                    qs[key] = rest[rest.index(flag) + 1]
            out(call("GET", f"/api/doc/{name}/query?{urllib.parse.urlencode(qs)}"))
        elif cmd == "changes":
            since = arg_value(rest, "--since", "0")
            out(call("GET", f"/api/doc/{name}/changes?since={since}"))
        else:
            out(call("GET", f"/api/doc/{name}/{cmd}"))
    elif cmd == "apply":
        name = rest[0]
        opsfile = arg_value(rest, "--ops", None)
        if opsfile is None:
            print("apply needs --ops <file.json> (a JSON array of ops; see --help)", file=sys.stderr)
            sys.exit(1)
        ops = json.loads(Path(opsfile).read_text(encoding="utf-8"))
        if isinstance(ops, dict):
            ops = [ops]
        out(call("POST", f"/api/doc/{name}/apply", {
            "by": arg_value(rest, "--by", "agent"),
            "label": arg_value(rest, "--label", None),
            "note": arg_value(rest, "--note", None),
            "ops": ops,
        }))
    elif cmd in ("undo", "redo", "compile", "adopt"):
        name = rest[0]
        body = {"by": arg_value(rest, "--by", "agent")} if cmd in ("undo", "redo") else {}
        if cmd == "compile" and "--force" in rest:
            body["force"] = True
        out(call("POST", f"/api/doc/{name}/{cmd}", body))
    elif cmd == "notes":
        out(call("GET", f"/api/doc/{rest[0]}/notes"))
    elif cmd == "note":
        if rest[1] == "rm":
            out(call("POST", f"/api/doc/{rest[0]}/notes", {"remove": rest[2]}))
        else:
            out(call("POST", f"/api/doc/{rest[0]}/notes", {"by": arg_value(rest, "--by", "agent"),
                                                           "x": float(rest[1]), "y": float(rest[2]), "text": rest[3]}))
    elif cmd == "select":
        out(call("POST", f"/api/doc/{rest[0]}/selection", {"by": arg_value(rest, "--by", "agent"),
                                                           "ids": [int(x) for x in rest[1:] if x.isdigit()]}))
    elif cmd == "assets":
        if rest and rest[0] == "sync":
            out(call("POST", "/api/mod-assets/sync", {}))
        else:
            r = call("GET", "/api/mod-assets")
            print(f"sprites: {len(r['sprites'])}  objects: {len(r['objects'])}  pages: {r['pages']}  .g.cs rewritten: {r.get('synced')}")
            for name, o in sorted(r["objects"].items()):
                print(f"  {name:<28} sprite={o.get('sprite')}  parent={o.get('parent')}  visible={o.get('visible')}")
            for w in r.get("warnings", []):
                print(f"warning: {w}", file=sys.stderr)
    elif cmd == "render":
        render(rest)
    else:
        print(f"unknown command {cmd!r} -- see --help", file=sys.stderr)
        sys.exit(1)


main()
