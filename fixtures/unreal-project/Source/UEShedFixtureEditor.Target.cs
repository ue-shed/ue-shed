using UnrealBuildTool;
using System.Collections.Generic;

public class UEShedFixtureEditorTarget : TargetRules
{
	public UEShedFixtureEditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.V6;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.AddRange(new string[] { "UEShedFixture", "UEShedFixtureEditor" });
	}
}
