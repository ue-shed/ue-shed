#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Character.h"
#include "GameFramework/GameModeBase.h"
#include "UEShedScenarioStateProvider.h"
#include "UEShedMovementGym.generated.h"

class UInputAction;

UCLASS()
class UESHEDFIXTURE_API AUEShedMovementGymPawn final : public ACharacter
{
	GENERATED_BODY()

public:
	AUEShedMovementGymPawn();
	virtual void SetupPlayerInputComponent(UInputComponent* PlayerInputComponent) override;

	int32 GetJumpCount() const { return JumpCount; }
	int32 GetInteractCount() const { return InteractCount; }
	int32 GetMoveFrameCount() const { return MoveFrameCount; }

private:
	void Move(const struct FInputActionValue& Value);
	void StartJump();
	void FinishJump();
	void Interact();

	UPROPERTY()
	TObjectPtr<UInputAction> MoveAction;

	UPROPERTY()
	TObjectPtr<UInputAction> JumpAction;

	UPROPERTY()
	TObjectPtr<UInputAction> InteractAction;

	int32 JumpCount = 0;
	int32 InteractCount = 0;
	int32 MoveFrameCount = 0;
};

UCLASS()
class UESHEDFIXTURE_API AUEShedMovementGymState final : public AActor,
	public IUEShedScenarioStateProvider
{
	GENERATED_BODY()

public:
	AUEShedMovementGymState();
	virtual void BeginPlay() override;
	virtual bool EvaluateScenarioCondition_Implementation(FName ConditionId) const override;
	virtual FString GetScenarioStateJson_Implementation() const override;

	void OpenCache();

private:
	const AUEShedMovementGymPawn* FindScenarioPawn() const;
	bool IsLandingReady() const;

	bool bCacheOpen = false;
	double StartWorldTime = 0.0;
};

UCLASS()
class UESHEDFIXTURE_API AUEShedMovementGymGameMode final : public AGameModeBase
{
	GENERATED_BODY()

public:
	AUEShedMovementGymGameMode();
};
