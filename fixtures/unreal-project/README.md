# Generic Unreal fixture

This directory will contain a small, reproducible project for integration and demo testing. It will
target a documented normal Unreal installation and contain no studio-project content or source-control
requirement.

The first fixture slice will add `/Game/Fixture/Observatory`, three deterministic moving actor
classes, procedural seeded placement, and an inspectable fixture contract version. Generated folders
and locally installed plugin binaries are ignored by the repository.

No `.uproject` placeholder is committed yet: the first Unreal slice must choose and document the
supported engine version, module layout, and bootstrap process together so the fixture is genuinely
openable rather than decorative.
