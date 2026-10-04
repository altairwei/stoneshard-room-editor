// Phase 2 verification + final extraction. Discovers that object display names come from
// global.inv_text (an ordered localized list: objects hardcode an index, e.g. o_barrel ->
// inv_text[29]). The 13-column rows are that list's rows in pool order. Write them fully
// so the app side can (a) rebuild per-language maps and (b) verify object -> key mapping.
using System;
using System.IO;
using System.Linq;
using System.Text.Json;

EnsureDataLoaded();

string outDir = Environment.GetEnvironmentVariable("SVRE_OUT") ?? ".";
Directory.CreateDirectory(Path.Combine(outDir, "lang"));

var rows = new System.Collections.Generic.List<(string key, string[] cols)>();
int n18 = 0, oKeyed = 0;
var oKeys = new System.Collections.Generic.List<string>();
foreach (var s in Data.Strings)
{
    if (s?.Content == null) continue;
    if (!System.Text.RegularExpressions.Regex.IsMatch(s.Content, @"^[A-Za-z_][A-Za-z0-9_]*;")) continue;
    var parts = s.Content.Split(';');
    if (parts.Length == 14) rows.Add((parts[0], parts.Skip(1).Take(13).ToArray()));
    else if (parts.Length == 19) n18++;
    if (parts[0].StartsWith("o_")) { oKeyed++; if (oKeys.Count < 40) oKeys.Add(parts[0]); }
}
Console.WriteLine($"13-col rows: {rows.Count}; 18-col rows: {n18}; o_ prefixed in 13-col: {oKeyed}");
Console.WriteLine("o_ key samples: " + string.Join(", ", oKeys.Take(25)));

var opts = new JsonWriterOptions { Indented = false };
using (var fs = File.Create(Path.Combine(outDir, "lang", "table13.json")))
using (var w = new Utf8JsonWriter(fs, opts))
{
    w.WriteStartArray();
    foreach (var (key, cols) in rows)
    {
        w.WriteStartObject();
        w.WriteString("k", key);
        w.WriteStartArray("c");
        foreach (var c in cols) w.WriteStringValue(c ?? "");
        w.WriteEndArray();
        w.WriteEndObject();
    }
    w.WriteEndArray();
}
Console.WriteLine("wrote lang/table13.json");