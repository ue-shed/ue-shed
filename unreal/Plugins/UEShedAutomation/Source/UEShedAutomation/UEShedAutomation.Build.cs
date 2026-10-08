using UnrealBuildTool;

public class UEShedAutomation : ModuleRules
{
	public UEShedAutomation(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine" });
		PrivateDependencyModuleNames.AddRange(new[] { "Json", "EnhancedInput", "UEShedCore" });
	}
}
