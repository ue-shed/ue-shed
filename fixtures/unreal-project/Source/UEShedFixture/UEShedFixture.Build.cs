using UnrealBuildTool;

public class UEShedFixture : ModuleRules
{
	public UEShedFixture(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(
			new string[]
			{
				"Core",
				"CoreUObject",
				"Engine",
				"EnhancedInput",
				"Json",
				"UEShedCameras",
				"UEShedScenarios"
			}
		);
	}
}
