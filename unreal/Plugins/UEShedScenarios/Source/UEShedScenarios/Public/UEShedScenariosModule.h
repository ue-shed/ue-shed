#pragma once

#include "CoreMinimal.h"
#include "Modules/ModuleInterface.h"
#include "Modules/ModuleManager.h"

enum class EUEShedScenarioActionValueType : uint8
{
	Boolean,
	Axis2D
};

struct FUEShedScenarioActionRegistration
{
	FName ActionId;
	FString PublicPath;
	FSoftObjectPath ObjectPath;
	EUEShedScenarioActionValueType ValueType = EUEShedScenarioActionValueType::Boolean;
};

struct FUEShedScenarioRegistration
{
	FName ScenarioId;
	FString MapPath;
};

class UESHEDSCENARIOS_API IUEShedScenariosModule : public IModuleInterface
{
public:
	static IUEShedScenariosModule& Get()
	{
		return FModuleManager::LoadModuleChecked<IUEShedScenariosModule>(TEXT("UEShedScenarios"));
	}

	virtual bool RegisterAction(const FUEShedScenarioActionRegistration& Registration) = 0;
	virtual const FUEShedScenarioActionRegistration* FindAction(FName ActionId) const = 0;
	virtual int32 RegisteredActionCount() const = 0;
	virtual bool RegisterScenario(const FUEShedScenarioRegistration& Registration) = 0;
	virtual const FUEShedScenarioRegistration* FindScenario(FName ScenarioId) const = 0;
};
