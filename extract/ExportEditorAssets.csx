// Headless asset export for stoneshard-room-editor.
//
//   UndertaleModCli.exe load <vallina.win> -s ExportEditorAssets.csx
//   (output dir from env SVRE_OUT; default = ../cache/assets next to this script's repo)
//
// Writes:
//   objects.json  every game object: sprite, parent, visible, depth, mask, event list
//   sprites.json  every sprite: size, origin, margins, and per-frame texture-page rects
//   pages/<i>.png every embedded texture page, unmodified (these ARE the game's atlases)
//   rooms.json    every room: name, size, instance count
//
// Everything here is game art or derived from it -- the output dir must stay out of
// git and out of any mod tree (MSL's TextureLoader turns any *.png under a mod into a sprite).
using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using UndertaleModLib.Models;

EnsureDataLoaded();

string outDir = Environment.GetEnvironmentVariable("SVRE_OUT");
if (string.IsNullOrEmpty(outDir))
    throw new Exception("set SVRE_OUT to the output directory");
Directory.CreateDirectory(Path.Combine(outDir, "pages"));

var opts = new JsonWriterOptions { Indented = false };

string N(UndertaleNamedResource r) => r?.Name?.Content;

// ---- objects ----
using (var fs = File.Create(Path.Combine(outDir, "objects.json")))
using (var w = new Utf8JsonWriter(fs, opts))
{
    w.WriteStartObject();
    foreach (var o in Data.GameObjects)
    {
        if (o?.Name?.Content == null) continue;
        w.WriteStartObject(o.Name.Content);
        if (o.Sprite != null) w.WriteString("sprite", N(o.Sprite));
        if (o.ParentId != null) w.WriteString("parent", N(o.ParentId));
        if (o.TextureMaskId != null) w.WriteString("mask", N(o.TextureMaskId));
        w.WriteBoolean("visible", o.Visible);
        w.WriteBoolean("persistent", o.Persistent);
        w.WriteNumber("depth", o.Depth);
        w.WriteStartArray("events");
        for (int t = 0; t < o.Events.Count; t++)
            foreach (var ev in o.Events[t])
            {
                w.WriteStartArray();
                w.WriteNumberValue(t);
                w.WriteNumberValue(ev.EventSubtype);
                w.WriteEndArray();
            }
        w.WriteEndArray();
        w.WriteEndObject();
    }
    w.WriteEndObject();
}

// ---- sprites ----
var pageIndex = new Dictionary<UndertaleEmbeddedTexture, int>();
for (int i = 0; i < Data.EmbeddedTextures.Count; i++) pageIndex[Data.EmbeddedTextures[i]] = i;

using (var fs = File.Create(Path.Combine(outDir, "sprites.json")))
using (var w = new Utf8JsonWriter(fs, opts))
{
    w.WriteStartObject();
    foreach (var s in Data.Sprites)
    {
        if (s?.Name?.Content == null) continue;
        w.WriteStartObject(s.Name.Content);
        w.WriteNumber("w", s.Width);
        w.WriteNumber("h", s.Height);
        w.WriteNumber("ox", s.OriginX);
        w.WriteNumber("oy", s.OriginY);
        w.WriteStartArray("margin"); // left, right, top, bottom (bbox, inclusive)
        w.WriteNumberValue(s.MarginLeft); w.WriteNumberValue(s.MarginRight);
        w.WriteNumberValue(s.MarginTop); w.WriteNumberValue(s.MarginBottom);
        w.WriteEndArray();
        // frame = [page, srcX, srcY, srcW, srcH, tgtX, tgtY, tgtW, tgtH, boundW, boundH]
        w.WriteStartArray("frames");
        foreach (var te in s.Textures)
        {
            var t = te?.Texture;
            w.WriteStartArray();
            if (t != null && t.TexturePage != null && pageIndex.TryGetValue(t.TexturePage, out int pi))
            {
                w.WriteNumberValue(pi);
                w.WriteNumberValue(t.SourceX); w.WriteNumberValue(t.SourceY);
                w.WriteNumberValue(t.SourceWidth); w.WriteNumberValue(t.SourceHeight);
                w.WriteNumberValue(t.TargetX); w.WriteNumberValue(t.TargetY);
                w.WriteNumberValue(t.TargetWidth); w.WriteNumberValue(t.TargetHeight);
                w.WriteNumberValue(t.BoundingWidth); w.WriteNumberValue(t.BoundingHeight);
            }
            w.WriteEndArray();
        }
        w.WriteEndArray();
        w.WriteEndObject();
    }
    w.WriteEndObject();
}

// ---- rooms ----
using (var fs = File.Create(Path.Combine(outDir, "rooms.json")))
using (var w = new Utf8JsonWriter(fs, opts))
{
    w.WriteStartArray();
    for (int i = 0; i < Data.Rooms.Count; i++)
    {
        var r = Data.Rooms[i];
        if (r?.Name?.Content == null) continue;
        w.WriteStartObject();
        w.WriteNumber("index", i);
        w.WriteString("name", r.Name.Content);
        w.WriteNumber("w", r.Width);
        w.WriteNumber("h", r.Height);
        w.WriteNumber("instances", r.GameObjects?.Count ?? 0);
        w.WriteEndObject();
    }
    w.WriteEndArray();
}

// ---- texture pages ----
int pages = 0, failed = 0;
await Task.Run(() =>
{
    Parallel.For(0, Data.EmbeddedTextures.Count, i =>
    {
        try
        {
            var img = Data.EmbeddedTextures[i].TextureData?.Image;
            if (img == null) { System.Threading.Interlocked.Increment(ref failed); return; }
            using var fs = File.Create(Path.Combine(outDir, "pages", $"{i}.png"));
            img.SavePng(fs);
            System.Threading.Interlocked.Increment(ref pages);
        }
        catch (Exception) { System.Threading.Interlocked.Increment(ref failed); }
    });
});

ScriptMessage($"objects={Data.GameObjects.Count} sprites={Data.Sprites.Count} rooms={Data.Rooms.Count} pages={pages} failed={failed}");
