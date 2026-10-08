#include "UEShedAutomationProfiler.h"

#include "Containers/Ticker.h"
#include "Modules/ModuleManager.h"

class FUEShedAutomationModule : public IModuleInterface
{
	FTSTicker::FDelegateHandle TickHandle;

public:
	virtual void StartupModule() override
	{
		TickHandle = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateLambda([](float)
		{
			UEShedAutomation::GetProfiler().Tick();
			return true;
		}));
	}

	virtual void ShutdownModule() override
	{
		FTSTicker::GetCoreTicker().RemoveTicker(TickHandle);
		UEShedAutomation::GetProfiler().Shutdown();
	}

	virtual bool SupportsDynamicReloading() override { return false; }
};

IMPLEMENT_MODULE(FUEShedAutomationModule, UEShedAutomation)
