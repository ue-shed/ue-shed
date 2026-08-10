#include "UEShedScenariosModule.h"

class FUEShedScenariosModule final : public IUEShedScenariosModule
{
public:
	virtual void StartupModule() override {}
	virtual void ShutdownModule() override
	{
		Actions.Reset();
		Scenarios.Reset();
	}

	virtual bool RegisterAction(const FUEShedScenarioActionRegistration& Registration) override
	{
		if (Registration.ActionId.IsNone() || Registration.PublicPath.IsEmpty()
			|| !Registration.ObjectPath.IsValid() || Actions.Contains(Registration.ActionId))
		{
			return false;
		}
		Actions.Add(Registration.ActionId, Registration);
		return true;
	}

	virtual const FUEShedScenarioActionRegistration* FindAction(FName ActionId) const override
	{
		return Actions.Find(ActionId);
	}

	virtual int32 RegisteredActionCount() const override { return Actions.Num(); }
	virtual bool RegisterScenario(const FUEShedScenarioRegistration& Registration) override
	{
		if (Registration.ScenarioId.IsNone() || !Registration.MapPath.StartsWith(TEXT("/Game/"))
			|| Scenarios.Contains(Registration.ScenarioId)) return false;
		Scenarios.Add(Registration.ScenarioId, Registration);
		return true;
	}
	virtual const FUEShedScenarioRegistration* FindScenario(FName ScenarioId) const override
	{
		return Scenarios.Find(ScenarioId);
	}

private:
	TMap<FName, FUEShedScenarioActionRegistration> Actions;
	TMap<FName, FUEShedScenarioRegistration> Scenarios;
};

IMPLEMENT_MODULE(FUEShedScenariosModule, UEShedScenarios)
