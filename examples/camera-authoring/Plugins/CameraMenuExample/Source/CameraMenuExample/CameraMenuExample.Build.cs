using UnrealBuildTool;
public class CameraMenuExample : ModuleRules
{
    public CameraMenuExample(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine" });
        PrivateDependencyModuleNames.AddRange(new[] { "Json", "ToolMenus", "Slate", "SlateCore", "UEShedCameraAuthoringBridge" });
    }
}
