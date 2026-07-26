#!/usr/bin/env python3
"""Stable CLI entrypoint for the backward-compatible 1С ЭДО surface."""

from trelio_one_c_runtime import main


if __name__ == "__main__":
    raise SystemExit(main(expected_skill_id="1c-edo"))
