using UnrealBuildTool;

public class UEShedNiagaraEditor : ModuleRules
{
	public UEShedNiagaraEditor(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PrivateDependencyModuleNames.AddRange(
			new[]
			{
				"AdvancedPreviewScene",
				"Core",
				"CoreUObject",
				"Engine",
				"ImageWrapper",
				"Json",
				"Niagara",
				"NiagaraCore",
				"NiagaraShader",
				"RenderCore",
				"Renderer",
				"RHI",
				"UnrealEd"
			}
		);
	}
}
