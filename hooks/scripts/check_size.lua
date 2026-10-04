-- check_size.lua: flags Lua files and functions that grew too long.
-- Usage: lua check_size.lua <maxFile> <maxFunc> <file1.lua> [file2.lua ...]
-- Output: one line per violation. Exit code 1 when there is at least one.
--
-- The source is tokenized (comments and strings skipped) to measure a function's real length,
-- whatever keywords sit in its strings and comments.

local maxFile = tonumber(arg[1]) or 500
local maxFunc = tonumber(arg[2]) or 60

local function readFile(path)
  local f = io.open(path, "rb")
  if not f then return nil end
  local c = f:read("*a")
  f:close()
  return c
end

-- Analyzes one file: returns its line count and the list of functions { name, startLine, length }.
local function analyze(src)
  local i, n = 1, #src
  local line = 1
  local stack = {}        -- open blocks { type, line, name }
  local funcs = {}

  -- Detects a long bracket [[ , [=[ , [==[ ... at position p.
  -- Returns (eqs, contentStart) or nil.
  local function longOpenAt(p)
    if src:sub(p, p) ~= "[" then return nil end
    local j = p + 1
    while src:sub(j, j) == "=" do j = j + 1 end
    if src:sub(j, j) == "[" then
      return (j - (p + 1)), j + 1
    end
    return nil
  end

  -- Skips to the matching ]=*], counting newlines on the way.
  local function skipLongBracket(eqs, startPos)
    local close = "]" .. string.rep("=", eqs) .. "]"
    local p = startPos
    while p <= n do
      local ch = src:sub(p, p)
      if ch == "\n" then
        line = line + 1; p = p + 1
      elseif ch == "]" and src:sub(p, p + #close - 1) == close then
        return p + #close
      else
        p = p + 1
      end
    end
    return n + 1
  end

  while i <= n do
    local c = src:sub(i, i)

    if c == "\n" then
      line = line + 1; i = i + 1

    elseif c == "-" and src:sub(i + 1, i + 1) == "-" then
      -- Comment (line or long block)
      local eqs, contentStart = longOpenAt(i + 2)
      if eqs then
        i = skipLongBracket(eqs, contentStart)
      else
        while i <= n and src:sub(i, i) ~= "\n" do i = i + 1 end
      end

    elseif c == '"' or c == "'" then
      -- Short string (handles escapes)
      local q = c
      i = i + 1
      while i <= n do
        local ch = src:sub(i, i)
        if ch == "\\" then i = i + 2
        elseif ch == "\n" then line = line + 1; i = i + 1
        elseif ch == q then i = i + 1; break
        else i = i + 1 end
      end

    elseif c == "[" then
      -- Possible long string
      local eqs, contentStart = longOpenAt(i)
      if eqs then i = skipLongBracket(eqs, contentStart) else i = i + 1 end

    elseif c:match("[A-Za-z_]") then
      local startId = i
      while i <= n and src:sub(i, i):match("[A-Za-z0-9_]") do i = i + 1 end
      local word = src:sub(startId, i - 1)

      if word == "function" then
        -- Captures the name (up to the opening parenthesis).
        local p = i
        while src:sub(p, p):match("[ \t]") do p = p + 1 end
        local ns = p
        while p <= n and src:sub(p, p) ~= "(" and src:sub(p, p) ~= "\n" do p = p + 1 end
        local name = src:sub(ns, p - 1):gsub("%s+$", "")
        if name == "" then name = "<anonymous>" end
        stack[#stack + 1] = { type = "function", line = line, name = name }
      elseif word == "if" or word == "do" or word == "repeat" then
        stack[#stack + 1] = { type = word, line = line }
      elseif word == "end" or word == "until" then
        local top = stack[#stack]
        stack[#stack] = nil
        if top and top.type == "function" then
          funcs[#funcs + 1] = {
            name = top.name,
            startLine = top.line,
            length = line - top.line + 1,
          }
        end
      end
      -- for / while left out on purpose: their `do` already balances the block.

    else
      i = i + 1
    end
  end

  return line, funcs
end

-- Just the file name, for display.
local function baseName(path)
  return (path:gsub("[/\\]+$", ""):gsub(".*[/\\]", ""))
end

local violations = 0
for idx = 3, #arg do
  local path = arg[idx]
  local src = readFile(path)
  if not src then
    io.stderr:write("  [!] Unreadable: " .. path .. "\n")
  else
    local total, funcs = analyze(src)
    if total > maxFile then
      violations = violations + 1
      print(string.format("[FILE] %s: %d lines (max %d, +%d)",
        baseName(path), total, maxFile, total - maxFile))
    end
    for _, fn in ipairs(funcs) do
      if fn.length > maxFunc then
        violations = violations + 1
        print(string.format("[FUNCTION] %s:%d  %s(): %d lines (max %d, +%d)",
          baseName(path), fn.startLine, fn.name, fn.length, maxFunc, fn.length - maxFunc))
      end
    end
  end
end

if violations > 0 then
  print(string.format("=> %d over the limit.", violations))
  os.exit(1)
else
  os.exit(0)
end
