using UnrealBuildTool;
using System.Collections.Generic;

public class UEShedFixtureTarget : TargetRules
{
	public UEShedFixtureTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("UEShedFixture");
	}
}
