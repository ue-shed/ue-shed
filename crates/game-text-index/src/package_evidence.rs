pub(crate) fn audience(code: u32) -> u32 {
    1 << (code & 3)
}
pub(crate) fn editor_only(code: u32) -> bool {
    code & 3 == 1 && (code >> 2) & 15 != 2
}
pub(crate) fn skips_editor(target: &serde_json::Value) -> bool {
    let mut steps = Vec::new();
    if let Some(configs) = target["configs"].as_array() {
        for config in configs {
            if let Some(values) = config["steps"].as_array() {
                for step in values {
                    if step["commandletClass"] == "GatherTextFromAssets" {
                        steps.push(
                            step["fields"]["ShouldGatherFromEditorOnlyData"]
                                .as_bool()
                                .or(config["common"]["ShouldGatherFromEditorOnlyData"].as_bool())
                                .unwrap_or(false),
                        );
                    }
                }
            }
        }
    }
    if !steps.is_empty() {
        return steps.iter().all(|v| !*v);
    }
    target["dashboard"]["settings"]["GatherFromPackages"]["IsEnabled"].as_bool() == Some(true)
        && target["dashboard"]["settings"]["GatherFromPackages"]["ShouldGatherFromEditorOnlyData"]
            .as_bool()
            != Some(true)
}
