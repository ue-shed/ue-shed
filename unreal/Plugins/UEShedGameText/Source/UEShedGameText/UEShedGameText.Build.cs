using UnrealBuildTool;

public class UEShedGameText : ModuleRules
{
	public UEShedGameText(ReadOnlyTargetRules Target) : base(Target)
	{
		if (Target.Version.MajorVersion < 5) CppStandard = CppStandardVersion.Cpp17;
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine" });
		PrivateDependencyModuleNames.AddRange(new[] { "BlueprintGraph", "Json", "UEShedCore", "UnrealEd" });
		if (Target.Version.MajorVersion < 5)
			PrivateDependencyModuleNames.AddRange(new[] { "EditorWidgets", "Slate", "SlateCore" });
	}
}
