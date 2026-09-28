// All-rooms export for sv-room-editor (bases for room projects). Derived from
// StoneValley/tools/roomgen/ExportRoomNC.csx, itself a non-interactive clone of MSL's own ExportRoom.csx (which needs GUI dialogs and
// therefore cannot run under the headless CLI). Same JSON schema, hardcoded I/O.
// Output is pure data -- asset names and numbers, no game art.
using System;
using System.IO;
using System.Text.Json;
using UndertaleModLib.Models;

EnsureDataLoaded();

string outputPath = System.IO.Path.Combine(Environment.GetEnvironmentVariable("SVRE_OUT") ?? throw new Exception("set SVRE_OUT"), "rooms");
Directory.CreateDirectory(outputPath);

JsonWriterOptions writerOptions = new JsonWriterOptions { Indented = true };

void WriteString(Utf8JsonWriter w, string name, UndertaleString s)
{
    if (s?.Content == null) w.WriteNull(name);
    else w.WriteString(name, s.Content);
}

void WriteRoomToJson(UndertaleRoom room)
{
    using MemoryStream stream = new MemoryStream();
    using Utf8JsonWriter w = new Utf8JsonWriter(stream, writerOptions);
    w.WriteStartObject();
    WriteString(w, "name", room.Name);
    WriteString(w, "caption", room.Caption);
    w.WriteNumber("width", room.Width);
    w.WriteNumber("height", room.Height);
    w.WriteNumber("speed", room.Speed);
    w.WriteBoolean("persistent", room.Persistent);
    w.WriteNumber("background_color", room.BackgroundColor ^ 0xFF000000);
    w.WriteBoolean("draw_background_color", room.DrawBackgroundColor);
    WriteString(w, "creation_code_id", room.CreationCodeId?.Name);
    w.WriteNumber("flags", Convert.ToInt32(room.Flags));
    w.WriteBoolean("world", room.World);
    w.WriteNumber("top", room.Top);
    w.WriteNumber("left", room.Left);
    w.WriteNumber("right", room.Right);
    w.WriteNumber("bottom", room.Bottom);
    w.WriteNumber("gravity_x", room.GravityX);
    w.WriteNumber("gravity_y", room.GravityY);
    w.WriteNumber("meters_per_pixel", room.MetersPerPixel);

    w.WriteStartArray("backgrounds");
    if (room.Backgrounds != null)
        foreach (var bg in room.Backgrounds)
        {
            w.WriteStartObject();
            if (bg != null)
            {
                w.WriteBoolean("enabled", bg.Enabled);
                w.WriteBoolean("foreground", bg.Foreground);
                WriteString(w, "background_definition", bg.BackgroundDefinition?.Name);
                w.WriteNumber("x", bg.X);
                w.WriteNumber("y", bg.Y);
                w.WriteBoolean("tiled_vertically", bg.TiledVertically);
                w.WriteBoolean("tiled_horizontally", bg.TiledHorizontally);
                w.WriteNumber("speed_x", bg.SpeedX);
                w.WriteNumber("speed_y", bg.SpeedY);
                w.WriteBoolean("stretch", bg.Stretch);
            }
            w.WriteEndObject();
        }
    w.WriteEndArray();

    w.WriteStartArray("views");
    if (room.Views != null)
        foreach (var v in room.Views)
        {
            w.WriteStartObject();
            if (v != null)
            {
                w.WriteBoolean("enabled", v.Enabled);
                w.WriteNumber("view_x", v.ViewX);
                w.WriteNumber("view_y", v.ViewY);
                w.WriteNumber("view_width", v.ViewWidth);
                w.WriteNumber("view_height", v.ViewHeight);
                w.WriteNumber("port_x", v.PortX);
                w.WriteNumber("port_y", v.PortY);
                w.WriteNumber("port_width", v.PortWidth);
                w.WriteNumber("port_height", v.PortHeight);
                w.WriteNumber("border_x", v.BorderX);
                w.WriteNumber("border_y", v.BorderY);
                w.WriteNumber("speed_x", v.SpeedX);
                w.WriteNumber("speed_y", v.SpeedY);
                WriteString(w, "object_id", v.ObjectId?.Name);
            }
            w.WriteEndObject();
        }
    w.WriteEndArray();

    void WriteInstance(Utf8JsonWriter w2, UndertaleRoom.GameObject go)
    {
        w2.WriteStartObject();
        w2.WriteNumber("x", go.X);
        w2.WriteNumber("y", go.Y);
        WriteString(w2, "object_definition", go.ObjectDefinition?.Name);
        w2.WriteNumber("instance_id", go.InstanceID);
        WriteString(w2, "creation_code", go.CreationCode?.Name);
        w2.WriteNumber("scale_x", go.ScaleX);
        w2.WriteNumber("scale_y", go.ScaleY);
        w2.WriteNumber("color", go.Color);
        w2.WriteNumber("rotation", go.Rotation);
        WriteString(w2, "pre_create_code", go.PreCreateCode?.Name);
        w2.WriteNumber("image_speed", go.ImageSpeed);
        w2.WriteNumber("image_index", go.ImageIndex);
        w2.WriteEndObject();
    }

    w.WriteStartArray("game_objects");
    if (room.GameObjects != null)
        foreach (var go in room.GameObjects)
            if (go != null) WriteInstance(w, go);
    w.WriteEndArray();

    w.WriteStartArray("tiles");
    if (room.Tiles != null)
        foreach (var t in room.Tiles)
        {
            w.WriteStartObject();
            if (t != null)
            {
                w.WriteBoolean("sprite_mode", t.spriteMode);
                w.WriteNumber("x", t.X);
                w.WriteNumber("y", t.Y);
                WriteString(w, "background_definition", t.BackgroundDefinition?.Name);
                WriteString(w, "sprite_definition", t.SpriteDefinition?.Name);
                w.WriteNumber("source_x", t.SourceX);
                w.WriteNumber("source_y", t.SourceY);
                w.WriteNumber("width", t.Width);
                w.WriteNumber("height", t.Height);
                w.WriteNumber("tile_depth", t.TileDepth);
                w.WriteNumber("instance_id", t.InstanceID);
                w.WriteNumber("scale_x", t.ScaleX);
                w.WriteNumber("scale_y", t.ScaleY);
                w.WriteNumber("color", t.Color);
            }
            w.WriteEndObject();
        }
    w.WriteEndArray();

    w.WriteStartArray("layers");
    if (room.Layers != null)
        foreach (var layer in room.Layers)
        {
            w.WriteStartObject();
            if (layer != null)
            {
                WriteString(w, "layer_name", layer.LayerName);
                w.WriteNumber("layer_id", layer.LayerId);
                w.WriteNumber("layer_type", Convert.ToInt32(layer.LayerType));
                w.WriteNumber("layer_depth", layer.LayerDepth);
                w.WriteNumber("x_offset", layer.XOffset);
                w.WriteNumber("y_offset", layer.YOffset);
                w.WriteNumber("h_speed", layer.HSpeed);
                w.WriteNumber("v_speed", layer.VSpeed);
                w.WriteBoolean("is_visible", layer.IsVisible);

                w.WriteStartObject("layer_data");
                if (layer.Data != null)
                {
                    switch (layer.LayerType)
                    {
                        case UndertaleRoom.LayerType.Background:
                        {
                            var d = (UndertaleRoom.Layer.LayerBackgroundData)layer.Data;
                            w.WriteBoolean("visible", d.Visible);
                            w.WriteBoolean("foreground", d.Foreground);
                            WriteString(w, "sprite", d.Sprite?.Name);
                            w.WriteBoolean("tiled_horizontally", d.TiledHorizontally);
                            w.WriteBoolean("tiled_vertically", d.TiledVertically);
                            w.WriteBoolean("stretch", d.Stretch);
                            w.WriteNumber("color", d.Color);
                            w.WriteNumber("first_frame", d.FirstFrame);
                            w.WriteNumber("animation_speed", d.AnimationSpeed);
                            w.WriteNumber("animation_speed_type", Convert.ToInt32(d.AnimationSpeedType));
                            break;
                        }
                        case UndertaleRoom.LayerType.Instances:
                        {
                            var d = (UndertaleRoom.Layer.LayerInstancesData)layer.Data;
                            w.WriteStartArray("instances");
                            if (d.Instances != null)
                                foreach (var inst in d.Instances)
                                    if (inst != null) WriteInstance(w, inst);
                            w.WriteEndArray();
                            break;
                        }
                        case UndertaleRoom.LayerType.Assets:
                        {
                            var d = (UndertaleRoom.Layer.LayerAssetsData)layer.Data;
                            w.WriteStartArray("legacy_tiles");
                            if (d.LegacyTiles != null)
                                foreach (var t in d.LegacyTiles)
                                {
                                    if (t == null) continue;
                                    w.WriteStartObject();
                                    w.WriteBoolean("sprite_mode", t.spriteMode);
                                    w.WriteNumber("x", t.X);
                                    w.WriteNumber("y", t.Y);
                                    WriteString(w, "background_definition", t.BackgroundDefinition?.Name);
                                    WriteString(w, "sprite_definition", t.SpriteDefinition?.Name);
                                    w.WriteNumber("source_x", t.SourceX);
                                    w.WriteNumber("source_y", t.SourceY);
                                    w.WriteNumber("width", t.Width);
                                    w.WriteNumber("height", t.Height);
                                    w.WriteNumber("tile_depth", t.TileDepth);
                                    w.WriteNumber("instance_id", t.InstanceID);
                                    w.WriteNumber("scale_x", t.ScaleX);
                                    w.WriteNumber("scale_y", t.ScaleY);
                                    w.WriteNumber("color", t.Color);
                                    w.WriteEndObject();
                                }
                            w.WriteEndArray();
                            w.WriteStartArray("sprites");
                            if (d.Sprites != null)
                                foreach (var s in d.Sprites)
                                {
                                    if (s == null) continue;
                                    w.WriteStartObject();
                                    WriteString(w, "name", s.Name);
                                    WriteString(w, "sprite", s.Sprite?.Name);
                                    w.WriteNumber("x", s.X);
                                    w.WriteNumber("y", s.Y);
                                    w.WriteNumber("scale_x", s.ScaleX);
                                    w.WriteNumber("scale_y", s.ScaleY);
                                    w.WriteNumber("color", s.Color);
                                    w.WriteNumber("animation_speed", s.AnimationSpeed);
                                    w.WriteNumber("animation_speed_type", Convert.ToInt32(s.AnimationSpeedType));
                                    w.WriteNumber("frame_index", s.FrameIndex);
                                    w.WriteNumber("rotation", s.Rotation);
                                    w.WriteEndObject();
                                }
                            w.WriteEndArray();
                            w.WriteStartArray("sequences");
                            if (d.Sequences != null)
                                foreach (var s in d.Sequences)
                                {
                                    if (s == null) continue;
                                    w.WriteStartObject();
                                    WriteString(w, "name", s.Name);
                                    WriteString(w, "sequence", s.Sequence?.Name);
                                    w.WriteNumber("x", s.X);
                                    w.WriteNumber("y", s.Y);
                                    w.WriteNumber("scale_x", s.ScaleX);
                                    w.WriteNumber("scale_y", s.ScaleY);
                                    w.WriteNumber("color", s.Color);
                                    w.WriteNumber("animation_speed", s.AnimationSpeed);
                                    w.WriteNumber("animation_speed_type", Convert.ToInt32(s.AnimationSpeedType));
                                    w.WriteNumber("frame_index", s.FrameIndex);
                                    w.WriteNumber("rotation", s.Rotation);
                                    w.WriteEndObject();
                                }
                            w.WriteEndArray();
                            w.WriteStartArray("nine_slices");
                            if (d.NineSlices != null)
                                foreach (var s in d.NineSlices)
                                {
                                    if (s == null) continue;
                                    w.WriteStartObject();
                                    WriteString(w, "name", s.Name);
                                    WriteString(w, "sprite", s.Sprite?.Name);
                                    w.WriteNumber("x", s.X);
                                    w.WriteNumber("y", s.Y);
                                    w.WriteNumber("scale_x", s.ScaleX);
                                    w.WriteNumber("scale_y", s.ScaleY);
                                    w.WriteNumber("color", s.Color);
                                    w.WriteNumber("animation_speed", s.AnimationSpeed);
                                    w.WriteNumber("animation_speed_type", Convert.ToInt32(s.AnimationSpeedType));
                                    w.WriteNumber("frame_index", s.FrameIndex);
                                    w.WriteNumber("rotation", s.Rotation);
                                    w.WriteEndObject();
                                }
                            w.WriteEndArray();
                            break;
                        }
                        case UndertaleRoom.LayerType.Tiles:
                        {
                            var d = (UndertaleRoom.Layer.LayerTilesData)layer.Data;
                            WriteString(w, "background", d.Background?.Name);
                            w.WriteNumber("tiles_x", d.TilesX);
                            w.WriteNumber("tiles_y", d.TilesY);
                            w.WriteStartArray("tile_data");
                            if (d.TileData != null)
                                foreach (var row in d.TileData)
                                {
                                    w.WriteStartArray();
                                    foreach (uint id in row)
                                    {
                                        w.WriteStartObject();
                                        w.WriteNumber("id", id);
                                        w.WriteEndObject();
                                    }
                                    w.WriteEndArray();
                                }
                            w.WriteEndArray();
                            break;
                        }
                    }
                }
                w.WriteEndObject();
            }
            w.WriteEndObject();
        }
    w.WriteEndArray();

    w.WriteEndObject();
    w.Flush();

    string path = Path.Combine(outputPath, room.Name.Content + ".json");
    File.WriteAllBytes(path, stream.ToArray());
}

// every room, plus an instance_id -> room index: GameMaker instance ids are global in a
// data file, so the ids a derived room still carries name the vanilla room it came from
var index = new System.Text.StringBuilder("{");
bool firstIdx = true;
foreach (var r in Data.Rooms)
{
    if (r?.Name?.Content == null) continue;
    WriteRoomToJson(r);
    foreach (var go in r.GameObjects)
    {
        if (go == null) continue;
        index.Append(firstIdx ? "" : ",").Append('"').Append(go.InstanceID).Append("\":\"").Append(r.Name.Content).Append('"');
        firstIdx = false;
    }
}
index.Append("}");
File.WriteAllText(Path.Combine(outputPath, "_index.json"), index.ToString());
ScriptMessage($"rooms export done: {Data.Rooms.Count}");
