#include "UEShedFixtureMover.h"

#include "Components/StaticMeshComponent.h"
#include "UObject/ConstructorHelpers.h"

#include UE_INLINE_GENERATED_CPP_BY_NAME(UEShedFixtureMover)

AUEShedFixtureMover::AUEShedFixtureMover()
{
	PrimaryActorTick.bCanEverTick = true;
	PrimaryActorTick.TickInterval = 0.0f;
	Mesh = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Mesh"));
	SetRootComponent(Mesh);
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cube(TEXT("/Engine/BasicShapes/Cube.Cube"));
	if (Cube.Succeeded()) Mesh->SetStaticMesh(Cube.Object);
	Mesh->SetRelativeScale3D(FVector(0.7, 0.7, 1.4));
	Mesh->SetMobility(EComponentMobility::Movable);
}

void AUEShedFixtureMover::BeginPlay()
{
	Super::BeginPlay();
	Origin = GetActorLocation();
}

void AUEShedFixtureMover::Tick(float DeltaTime)
{
	Super::Tick(DeltaTime);
	const double T = GetWorld()->GetTimeSeconds() * Speed + LogicalIndex * 0.73;
	FVector Offset;
	switch (Motion)
	{
	case EUEShedFixtureMotion::Orbit:
		Offset = FVector(FMath::Cos(T), FMath::Sin(T), 0.25 * FMath::Sin(T * 2.0)) * Radius;
		break;
	case EUEShedFixtureMotion::PingPong:
		Offset = FVector(FMath::Sin(T), 0.0, 0.3 * FMath::Cos(T * 1.7)) * Radius;
		break;
	case EUEShedFixtureMotion::FigureEight:
		Offset = FVector(FMath::Sin(T), FMath::Sin(T * 2.0) * 0.5, 0.2 * FMath::Cos(T)) * Radius;
		break;
	default:
		break;
	}
	SetActorLocation(Origin + Offset, false, nullptr, ETeleportType::TeleportPhysics);
	SetActorRotation(FRotator(0.0, FMath::RadiansToDegrees(T), 0.0));
}
