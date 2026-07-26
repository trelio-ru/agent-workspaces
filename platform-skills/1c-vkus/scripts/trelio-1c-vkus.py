#!/usr/bin/env python3
"""Stable CLI entrypoint for the Vkus-private broad read-only 1С surface."""

from trelio_one_c_vkus_runtime import VKUS_SKILL_ID, main


if __name__ == "__main__":
    raise SystemExit(main(expected_skill_id=VKUS_SKILL_ID))
