#include "Modules/ModuleManager.h"
#include "Runtime/Launch/Resources/Version.h"

// UE 4.27 builds only asset navigation and window activation from this module
// (`LEGACY_CORE_EDITOR_SOURCES` in scripts/plugin-bundle.ts); the rest is UE5 only.
#if ENGINE_MAJOR_VERSION >= 5
#include "UEShedEditorResponsivenessLibrary.h"
#include "UEShedEditorWorldControlLibrary.h"
#endif

class FUEShedCoreEditorModule : public IModuleInterface
{
	virtual void StartupModule() override
	{
#if ENGINE_MAJOR_VERSION >= 5
		UUEShedEditorResponsivenessLibrary::StartForegroundResponsiveness();
#endif
	}
	virtual void ShutdownModule() override
	{
#if ENGINE_MAJOR_VERSION >= 5
		UUEShedEditorResponsivenessLibrary::ShutdownForegroundResponsiveness();
		UUEShedEditorWorldControlLibrary::ShutdownWorldControl();
#endif
	}
};
IMPLEMENT_MODULE(FUEShedCoreEditorModule, UEShedCoreEditor)
