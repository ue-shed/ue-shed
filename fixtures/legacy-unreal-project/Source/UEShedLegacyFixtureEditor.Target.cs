using UnrealBuildTool;

public class UEShedLegacyFixtureEditorTarget : TargetRules
{
	public UEShedLegacyFixtureEditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		ExtraModuleNames.AddRange(new string[] { "UEShedLegacyFixture", "UEShedLegacyFixtureEditor" });
	}
}
