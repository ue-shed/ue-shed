#include "Modules/ModuleManager.h"
#include "UEShedEditorResponsivenessLibrary.h"
#include "UEShedEditorWorldControlLibrary.h"

class FUEShedCoreEditorModule : public IModuleInterface
{
	virtual void StartupModule() override
	{
		UUEShedEditorResponsivenessLibrary::StartForegroundResponsiveness();
	}
	virtual void ShutdownModule() override
	{
		UUEShedEditorResponsivenessLibrary::ShutdownForegroundResponsiveness();
		UUEShedEditorWorldControlLibrary::ShutdownWorldControl();
	}
};
IMPLEMENT_MODULE(FUEShedCoreEditorModule, UEShedCoreEditor)
