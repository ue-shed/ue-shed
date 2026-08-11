# UEShedScenarios

Optional UE 5.7 PIE scenario execution capability. The runtime module owns the explicit action and
world-state provider seams; the editor module exposes bounded start/status/cancel control through
Remote Control. Input values enter Enhanced Input at the verified pre-evaluation layer.

The plugin is disabled by default and advertises capabilities only when `UEShedScenariosEditor` is
loaded.
