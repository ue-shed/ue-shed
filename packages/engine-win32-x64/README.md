# `@ue-shed/engine-win32-x64`

Windows x64 native artifact for `@ue-shed/engine` scoped process ownership. The helper creates the
requested process suspended, assigns it to a private kill-on-close Job Object, and resumes it only
after assignment. Install `@ue-shed/engine`; its optional dependency selects this package.

The executable is an internal adapter protocol, not a shell or a general-purpose command runner.
