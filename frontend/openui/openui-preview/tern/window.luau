-- A narrow opt-in file route; no model-supplied command or executable code.
tern.route.open(function(req, _cx)
    if string.match(req.path, "%.hvisual%.json$") and req.how ~= "replace" then
        return {block = "hermes-openui.reply", args = {req.path}}
    end
    return nil
end)
