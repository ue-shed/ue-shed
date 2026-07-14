#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "UEShedFixtureMover.generated.h"

UENUM()
enum class EUEShedFixtureMotion : uint8
{
	Orbit,
	PingPong,
	FigureEight
};

UCLASS()
class UESHEDFIXTURE_API AUEShedFixtureMover : public AActor
{
	GENERATED_BODY()

public:
	AUEShedFixtureMover();
	virtual void BeginPlay() override;
	virtual void Tick(float DeltaTime) override;

	UPROPERTY(EditAnywhere, Category = "Fixture")
	int32 LogicalIndex = 0;

	UPROPERTY(EditAnywhere, Category = "Fixture")
	EUEShedFixtureMotion Motion = EUEShedFixtureMotion::Orbit;

	UPROPERTY(EditAnywhere, Category = "Fixture")
	float Radius = 400.0f;

	UPROPERTY(EditAnywhere, Category = "Fixture")
	float Speed = 0.6f;

private:
	UPROPERTY(VisibleAnywhere)
	TObjectPtr<class UStaticMeshComponent> Mesh;

	FVector Origin = FVector::ZeroVector;
};
