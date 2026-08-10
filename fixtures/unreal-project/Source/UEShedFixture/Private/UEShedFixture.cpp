#include "Modules/ModuleManager.h"
#include "UEShedScenariosModule.h"

class FUEShedFixtureModule final : public FDefaultGameModuleImpl
{
public:
	virtual void StartupModule() override
	{
		FDefaultGameModuleImpl::StartupModule();
		IUEShedScenariosModule& Scenarios = IUEShedScenariosModule::Get();
		Scenarios.RegisterScenario({
			TEXT("scenario_movement-gym_014"),
			TEXT("/Game/Fixture/Scenarios/L_MovementGym")
		});
		Scenarios.RegisterAction({
			TEXT("Move"),
			TEXT("/Game/Fixture/Input/IA_Move"),
			FSoftObjectPath(TEXT("/Game/Fixture/Input/IA_Move.IA_Move")),
			EUEShedScenarioActionValueType::Axis2D
		});
		Scenarios.RegisterAction({
			TEXT("Jump"),
			TEXT("/Game/Fixture/Input/IA_Jump"),
			FSoftObjectPath(TEXT("/Game/Fixture/Input/IA_Jump.IA_Jump")),
			EUEShedScenarioActionValueType::Boolean
		});
		Scenarios.RegisterAction({
			TEXT("Interact"),
			TEXT("/Game/Fixture/Input/IA_Interact"),
			FSoftObjectPath(TEXT("/Game/Fixture/Input/IA_Interact.IA_Interact")),
			EUEShedScenarioActionValueType::Boolean
		});
	}
};

IMPLEMENT_PRIMARY_GAME_MODULE(FUEShedFixtureModule, UEShedFixture, "UEShedFixture");
