#include "Modules/ModuleManager.h"

#include "UEShedScenarioExecution.h"

class FUEShedScenariosEditorModule final : public IModuleInterface
{
public:
	virtual void StartupModule() override { GetUEShedScenarioExecution().Startup(); }
	virtual void ShutdownModule() override { GetUEShedScenarioExecution().Shutdown(); }
};

IMPLEMENT_MODULE(FUEShedScenariosEditorModule, UEShedScenariosEditor)
