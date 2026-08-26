# Documentation And Process Guidelines

Applies to `docs`, `.trellis`, PR templates, and process-only changes.

## Pre-Development Checklist

- Read `.trellis/workflow.md`.
- Read `AGENTS.md`.
- Check whether the change updates project facts or only process guidance.
- When updating Trellis, keep runtime files under `.trellis/` instead of `docs/trellis/`.

## Required Rules

- Use `.trellis/tasks/{MM-DD-slug}/` for task artifacts.
- PRD describes requirements and acceptance only.
- `design.md` describes technical design for complex tasks.
- `implement.md` describes the ordered execution checklist and validation.
- Preserve references to source docs when summarizing project constraints.

## Quality Check

- Run Prettier on changed Markdown when practical.
- Run `python ./.trellis/scripts/get_context.py --mode packages` after changing config/spec structure.
