using UnrealBuildTool;

public class UEShedCore : ModuleRules
{
	public UEShedCore(ReadOnlyTargetRules Target) : base(Target)
	{
		if (Target.Version.MajorVersion < 5) CppStandard = CppStandardVersion.Cpp17;
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine" });
		PrivateDependencyModuleNames.AddRange(new[] { "Json", "Projects" });
	}
}
