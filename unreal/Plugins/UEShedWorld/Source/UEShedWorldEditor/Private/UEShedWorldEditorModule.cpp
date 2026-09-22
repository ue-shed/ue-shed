#include "Modules/ModuleManager.h"
#include "UEShedWorldPreparation.h"

class FUEShedWorldEditorModule final : public IModuleInterface
{
	void StartupModule() override
	{
		FUEShedWorldPreparation::Startup();
	}
	void ShutdownModule() override
	{
		FUEShedWorldPreparation::Shutdown();
	}
};
IMPLEMENT_MODULE(FUEShedWorldEditorModule, UEShedWorldEditor)
