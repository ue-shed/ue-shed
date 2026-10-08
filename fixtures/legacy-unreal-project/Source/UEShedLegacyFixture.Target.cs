using UnrealBuildTool;

public class UEShedLegacyFixtureTarget : TargetRules
{
	public UEShedLegacyFixtureTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.V2;
		ExtraModuleNames.Add("UEShedLegacyFixture");
	}
}
