# UE Shed Workbench

The optional Electron showcase and dogfood client. It will demonstrate what can be built with public
UE Shed libraries, but it must never own domain behavior or receive privileged engine access.

The renderer uses SolidJS and composes shared StyleX themes/primitives with independently owned
product-extension styles. Workbench may select a theme but must not repair extensions through global
CSS overrides.

Implementation begins after the CLI can complete the first connection and capability flow.
