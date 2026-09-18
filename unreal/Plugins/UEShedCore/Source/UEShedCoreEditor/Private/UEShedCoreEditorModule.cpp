#include "Modules/ModuleManager.h"
#include "UEShedEditorWorldControlLibrary.h"

class FUEShedCoreEditorModule : public IModuleInterface
{
	virtual void ShutdownModule() override
	{
		UUEShedEditorWorldControlLibrary::ShutdownWorldControl();
	}
};
IMPLEMENT_MODULE(FUEShedCoreEditorModule, UEShedCoreEditor)
