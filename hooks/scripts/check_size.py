#!/usr/bin/env python3
"""check_size.py - size guard for Python, through the `ast` module.

Same contract as check_size.lua, so file-size-guard.js can call either one without knowing which:

    python check_size.py <maxFile> <maxFunction> <file.py> [...]

One line per violation on stdout. Exit code 1 when there is at least one, 0 otherwise.

Unlike the brace heuristic used for the C-like languages, this analysis is EXACT: `ast` gives the
real bounds of every function, method and coroutine, nested ones included.
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path


def function_lengths(source: str):
    """[(qualified_name, start_line, length)] for every function."""
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return None

    results = []

    def visit(node, prefix=""):
        for child in ast.iter_child_nodes(node):
            name = getattr(child, "name", None)
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                qualified = f"{prefix}{name}"
                start = child.lineno
                # To a reader, the decorator is part of the function.
                if child.decorator_list:
                    start = min(start, min(d.lineno for d in child.decorator_list))
                end = getattr(child, "end_lineno", start)
                results.append((qualified, start, end - start + 1))
                visit(child, prefix=f"{qualified}.")
            elif isinstance(child, ast.ClassDef):
                visit(child, prefix=f"{prefix}{name}.")
            else:
                visit(child, prefix=prefix)

    visit(tree)
    return results


def main() -> int:
    if len(sys.argv) < 4:
        print("usage: check_size.py <maxFile> <maxFunction> <file.py> [...]", file=sys.stderr)
        return 2

    max_file = int(sys.argv[1])
    max_func = int(sys.argv[2])
    violations = 0

    for arg in sys.argv[3:]:
        path = Path(arg)
        try:
            source = path.read_text(encoding="utf-8-sig", errors="replace")
        except OSError:
            print(f"  [!] Unreadable: {arg}", file=sys.stderr)
            continue

        total = len(source.splitlines())
        if total > max_file:
            violations += 1
            print(f"[FILE] {path.name}: {total} lines (max {max_file}, +{total - max_file})")

        functions = function_lengths(source)
        if functions is None:
            # Invalid syntax: the file is being written. Saying nothing beats a wrong alarm.
            continue

        for name, start, length in functions:
            if length > max_func:
                violations += 1
                print(
                    f"[FUNCTION] {path.name}:{start}  {name}(): {length} lines "
                    f"(max {max_func}, +{length - max_func})"
                )

    if violations:
        print(f"=> {violations} over the limit.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
