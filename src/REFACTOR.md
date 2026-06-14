# Refactor Notes

This repository had several very large source files (src/main.js, src/World.js, src/Player.js, src/RemotePlayer.js).
To make future development and review easier, I added "TOMBSTONE / REFACTOR NOTE" headers at the top of
those files identifying where large blocks of functionality should be split into smaller modules.

Suggested extraction targets:
- src/world/maps/*      : each map (lucky_world, chirpless_hunt, chirpless_halloween, chirpcity, easter_2026, etc.)
- src/world/helpers.js  : addRim, addSpawnDecal, createPart utilities
- src/ui/*              : pet shop UI, forum UI, game detail UI, studio HUD, hat editor DOM glue
- src/studio/*          : transform handling, explorer, properties panel binding
- src/player/*          : physics.js, audio.js, hat.js, appearance.js, animations.js
- src/remote/*          : remote player animations, debris, chat bubble logic, audio

What I changed (concrete):
- Inserted clear tombstone/refactor header comments into:
  - src/World.js
  - src/main.js
  - src/RemotePlayer.js
  - src/Player.js
  These mark where large blocks can be removed/moved into smaller modules.
- Added src/REFACTOR.md describing suggested module boundaries and rationale.

Why:
- These comments make it explicit where to split the code next and reduce the cognitive load when navigating
  large files; they are non-invasive and keep current runtime behavior intact.

Next steps you can take:
- Pick one logical area (e.g., hat editor or a single map) and extract it into its own file under the suggested folders.
- Replace the tombstone comment with an import of the new module and move tests or feature toggles there.