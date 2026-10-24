-- Runs the Lua-compatible subset under Lua 5.4 with a stubbed Tern API.
-- NOT Luau validation, browser/Tern rendering, screenshots, or input-to-paint evidence.
local def, fixture, reads, sorts = nil, nil, 0, 0
local sort = table.sort
table.sort = function(...) sorts = sorts + 1; return sort(...) end
local function node(k, p, c) return {k = k, p = p or {}, c = c or {}} end
tern = {
    block = {define = function(id, value) assert(id == "reply"); def = value end},
    fs = {read = function(path) assert(path == "/fixture.hvisual.json"); reads = reads + 1; return "{}" end},
    json = {decode = function() return fixture end},
    ui = {
        text = function(text) return node("text", {text = text}) end,
        col = function(c) return node("col", nil, c) end,
        row = function(c) return node("row", nil, c) end,
        el = function(tag, p, c) return node("el", p, c) end,
        node = node,
    },
}
assert(loadfile(arg[1] or "tern/host.luau"))()
local function leaf(id, code, churn) return {id = id, label = id .. ".ts", code = code, churn = churn, children = {}} end
local function setup(mode, metrics, limit)
    local src = {id = "src", label = "src/", code = 700, churn = 85, children = {leaf("engine", 500, 60), leaf("view", 200, 25)}}
    local tests = {id = "tests", label = "tests/", code = 250, churn = 10, children = {leaf("spec", 250, 10)}}
    local root = {id = "repo", label = "demo", code = 1000, churn = 100, children = {src, tests, leaf("readme", 50, 5)}}
    fixture = {
        schema = "hermes-openui-preview/v1", id = string.rep("a", 64),
        selection = {schema = "native-visual-selection/v1", status = "validated-not-verified",
            snapshot = {id = string.rep("b", 64), rendererHash = string.rep("c", 64)},
            view = {kind = "repo-explorer", mode = mode or "code", metrics = metrics or {"files", "code", "churn"}, hottestLimit = limit or 8, visibleLimit = 128}},
        artifact = {id = string.rep("b", 64), rendererHash = string.rep("c", 64), document = {version = 1, title = "Synthetic fixture", root = root}},
    }
    return def.init({}, {"/fixture.hvisual.json"}, nil)
end
local function eq(a, b) assert(a == b, tostring(a) .. " ~= " .. tostring(b)) end
local count = 0
local function test(name, fn)
    fn(); count = count + 1; print("ok " .. count .. " - " .. name)
end
test("selected mode and metrics come from the OpenUI selection", function()
    local s = setup("churn", {"files"}, 2)
    eq(s.mode, "churn")
    local frame = def.view(s, {})
    eq(frame.main.c[2].p.text, "files: 4")
    eq(#frame.main.c[6].p.series, 2)
end)
test("hottest bars rank actual descendant files, not directories", function()
    local s = setup()
    local series = def.view(s, {}).main.c[6].p.series
    eq(series[1].label, "engine.ts"); eq(series[1].value, 60)
    eq(series[2].label, "view.ts"); eq(#series, 4)
end)
test("full revision is visible and never labelled published", function()
    local s = setup(); local frame = def.view(s, {})
    eq(frame.dock.c[1].p.text, "Preview: " .. string.rep("a", 64))
    assert(string.find(frame.dock.c[3].p.text, "Not published", 1, true))
end)
test("pointer drill and keyboard Back restore the selected directory", function()
    local s = setup()
    def.event(s, {ev = "action", act = "drill", value = "tests"}, {})
    eq(s.current.id, "tests")
    assert(def.key(s, {name = "left"}, {})); eq(s.current.id, "repo")
    eq(s.items[s.selected].id, "tests")
    assert(def.key(s, {name = "enter"}, {})); eq(s.current.id, "tests")
end)
test("mode switching preserves selection by identity", function()
    local s = setup()
    def.key(s, {name = "down"}, {})
    local selected = s.items[s.selected].id
    def.key(s, {name = "2"}, {}); eq(s.items[s.selected].id, selected)
end)
test("unknown or modified keys do not schedule new views", function()
    local s = setup(); local first = def.view(s, {})
    eq(def.key(s, {name = "z"}, {}), false)
    eq(def.key(s, {name = "2", ctrl = true}, {}), false)
    eq(def.view(s, {}), first); eq(s.mode, "code")
end)
test("unchanged views reuse the same node tree without reads", function()
    local s = setup(); local first = def.view(s, {}); local before = reads
    for i = 1, 40 do eq(def.view(s, {}), first) end
    eq(reads, before)
end)
test("warm mode switches cause no extra sort or filesystem read", function()
    local s = setup(); def.key(s, {name = "2"}, {})
    local before, readBefore = sorts, reads
    for i = 1, 40 do def.key(s, {name = "1"}, {}); def.view(s, {}); def.key(s, {name = "2"}, {}); def.view(s, {}) end
    eq(sorts, before); eq(reads, readBefore)
end)
test("unknown actions cannot open files, execute code or mutate selection", function()
    local s = setup(); local first = def.view(s, {})
    def.event(s, {ev = "action", act = "run", value = "ignored"}, {})
    def.event(s, {ev = "action", act = "drill", value = "missing"}, {})
    eq(def.view(s, {}), first)
end)
test("invalid data fails at load rather than showing fabricated aggregates", function()
    setup(); fixture.artifact.document.root.code = 3
    assert(not pcall(def.init, {}, {"/fixture.hvisual.json"}, nil))
end)
test("visible cell count is bounded with expandable Other and truthful totals", function()
    setup(); local root = fixture.artifact.document.root; root.children = {}; root.code = 150; root.churn = 150
    for i = 1, 150 do table.insert(root.children, leaf("f" .. i, 1, 1)) end
    local s = def.init({}, {"/fixture.hvisual.json"}, nil)
    eq(#s.items, 128); local other = s.items[128]
    eq(#other.children, 23); eq(other.code, 23); eq(s.files[other], 23)
    def.event(s, {ev = "action", act = "drill", value = other.id}, {})
    eq(#s.items, 23)
end)
test("restart resets transient navigation and cannot restore an approval", function()
    setup(); local s = def.init({}, {"/fixture.hvisual.json"}, {mode = "churn", approved = true})
    eq(s.mode, "code"); eq(s.current.id, "repo"); eq(s.approved, nil); eq(def.save, nil)
end)
print(count .. " renderer-logic checks passed (Lua 5.4 + stub Tern; not live Luau/Tern)")
