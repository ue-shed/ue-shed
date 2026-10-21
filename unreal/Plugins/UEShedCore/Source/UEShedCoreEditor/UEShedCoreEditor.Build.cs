using UnrealBuildTool;

public class UEShedCoreEditor : ModuleRules
{
	public UEShedCoreEditor(ReadOnlyTargetRules Target) : base(Target)
	{
		if (Target.Version.MajorVersion < 5) CppStandard = CppStandardVersion.Cpp17;
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine" });
		PrivateDependencyModuleNames.AddRange(new[]
		{
			"AssetRegistry",
			"ContentBrowser",
			"Json",
			"LevelEditor",
			"MainFrame",
			"ApplicationCore",
			"Slate",
			"SlateCore",
			"UEShedCore",
			"UnrealEd"
		});
	}
}
