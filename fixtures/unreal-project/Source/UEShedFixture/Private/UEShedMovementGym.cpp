#include "UEShedMovementGym.h"

#include "EnhancedInputComponent.h"
#include "EngineUtils.h"
#include "GameFramework/CharacterMovementComponent.h"
#include "InputAction.h"
#include "InputActionValue.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

AUEShedMovementGymPawn::AUEShedMovementGymPawn()
{
	GetCharacterMovement()->MaxWalkSpeed = 600.0f;
	MoveAction = LoadObject<UInputAction>(nullptr,
		TEXT("/Game/Fixture/Input/IA_Move.IA_Move"));
	JumpAction = LoadObject<UInputAction>(nullptr,
		TEXT("/Game/Fixture/Input/IA_Jump.IA_Jump"));
	InteractAction = LoadObject<UInputAction>(nullptr,
		TEXT("/Game/Fixture/Input/IA_Interact.IA_Interact"));
}

void AUEShedMovementGymPawn::SetupPlayerInputComponent(UInputComponent* PlayerInputComponent)
{
	Super::SetupPlayerInputComponent(PlayerInputComponent);
	UEnhancedInputComponent* Enhanced = CastChecked<UEnhancedInputComponent>(PlayerInputComponent);
	check(MoveAction != nullptr && JumpAction != nullptr && InteractAction != nullptr);
	Enhanced->BindAction(MoveAction, ETriggerEvent::Triggered, this,
		&AUEShedMovementGymPawn::Move);
	Enhanced->BindAction(JumpAction, ETriggerEvent::Started, this,
		&AUEShedMovementGymPawn::StartJump);
	Enhanced->BindAction(JumpAction, ETriggerEvent::Completed, this,
		&AUEShedMovementGymPawn::FinishJump);
	Enhanced->BindAction(InteractAction, ETriggerEvent::Started, this,
		&AUEShedMovementGymPawn::Interact);
}

void AUEShedMovementGymPawn::Move(const FInputActionValue& Value)
{
	const FVector2D Axis = Value.Get<FVector2D>();
	AddMovementInput(GetActorForwardVector(), Axis.Y);
	AddMovementInput(GetActorRightVector(), Axis.X);
	++MoveFrameCount;
}

void AUEShedMovementGymPawn::StartJump()
{
	++JumpCount;
	Jump();
}

void AUEShedMovementGymPawn::FinishJump()
{
	StopJumping();
}

void AUEShedMovementGymPawn::Interact()
{
	++InteractCount;
	for (TActorIterator<AUEShedMovementGymState> It(GetWorld()); It; ++It)
	{
		It->OpenCache();
		return;
	}
}

AUEShedMovementGymState::AUEShedMovementGymState()
{
	PrimaryActorTick.bCanEverTick = false;
}

void AUEShedMovementGymState::BeginPlay()
{
	Super::BeginPlay();
	StartWorldTime = GetWorld() == nullptr ? 0.0 : GetWorld()->GetTimeSeconds();
}

const AUEShedMovementGymPawn* AUEShedMovementGymState::FindScenarioPawn() const
{
	for (TActorIterator<AUEShedMovementGymPawn> It(GetWorld()); It; ++It) return *It;
	return nullptr;
}

bool AUEShedMovementGymState::IsLandingReady() const
{
	const AUEShedMovementGymPawn* Pawn = FindScenarioPawn();
	if (Pawn == nullptr || Pawn->GetCharacterMovement() == nullptr) return false;
	const double Now = GetWorld() == nullptr ? 0.0 : GetWorld()->GetTimeSeconds();
	return Pawn->GetJumpCount() > 0 && !Pawn->GetCharacterMovement()->IsFalling()
		&& Pawn->GetActorLocation().X > 850.0 && Now - StartWorldTime >= 3.9;
}

bool AUEShedMovementGymState::EvaluateScenarioCondition_Implementation(
	const FName ConditionId) const
{
	if (ConditionId == TEXT("landing_ready")) return IsLandingReady();
	if (ConditionId == TEXT("cache_open")) return bCacheOpen;
	return false;
}

void AUEShedMovementGymState::OpenCache()
{
	if (IsLandingReady()) bCacheOpen = true;
}

FString AUEShedMovementGymState::GetScenarioStateJson_Implementation() const
{
	const AUEShedMovementGymPawn* Pawn = FindScenarioPawn();
	TSharedRef<FJsonObject> State = MakeShared<FJsonObject>();
	State->SetBoolField(TEXT("landingReady"), IsLandingReady());
	State->SetBoolField(TEXT("cacheOpen"), bCacheOpen);
	if (Pawn != nullptr)
	{
		const FVector Location = Pawn->GetActorLocation();
		TSharedRef<FJsonObject> PawnJson = MakeShared<FJsonObject>();
		PawnJson->SetNumberField(TEXT("x"), Location.X);
		PawnJson->SetNumberField(TEXT("y"), Location.Y);
		PawnJson->SetNumberField(TEXT("z"), Location.Z);
		PawnJson->SetNumberField(TEXT("jumpCount"), Pawn->GetJumpCount());
		PawnJson->SetNumberField(TEXT("interactCount"), Pawn->GetInteractCount());
		PawnJson->SetNumberField(TEXT("moveFrameCount"), Pawn->GetMoveFrameCount());
		State->SetObjectField(TEXT("pawn"), PawnJson);
	}
	FString Json;
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Json);
	FJsonSerializer::Serialize(State, Writer);
	return Json;
}

AUEShedMovementGymGameMode::AUEShedMovementGymGameMode()
{
	DefaultPawnClass = AUEShedMovementGymPawn::StaticClass();
}
