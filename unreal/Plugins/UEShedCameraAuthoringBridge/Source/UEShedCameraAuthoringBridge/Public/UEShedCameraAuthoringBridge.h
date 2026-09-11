#pragma once
#include "CoreMinimal.h"
#include "Camera/CameraActor.h"
#include "Dom/JsonObject.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "UEShedCameraAuthoringBridge.generated.h"

/** Ephemeral, transactional camera. Neither this actor nor its components are saved with the map. */
UCLASS(Transient, NotPlaceable)
class UESHEDCAMERAAUTHORINGBRIDGE_API AUEShedAuthoringCamera : public ACameraActor
{
	GENERATED_BODY()
public:
	AUEShedAuthoringCamera();
};

/** The same public port is used by Remote Control and replacement native menus. Game thread only. */
class UESHEDCAMERAAUTHORINGBRIDGE_API FUEShedCameraAuthoringBridge
{
public:
	static TSharedPtr<FJsonObject> Execute(const TSharedPtr<FJsonObject>& Request);
	static AUEShedAuthoringCamera* Camera();
	static TSharedPtr<FJsonObject> InspectActive();
	// Optional presentation adapters can reveal their camera tools on editor handoff.
	static FSimpleMulticastDelegate& OnEditorFocusRequested();
	static void Shutdown();
	static bool Tick(float DeltaSeconds);
};

UCLASS()
class UESHEDCAMERAAUTHORINGBRIDGE_API UUEShedCameraAuthoringBridgeLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()
public:
	UFUNCTION(BlueprintCallable, Category="UE Shed|Camera Authoring")
	static void ExecuteCameraAuthoring(const FString& RequestJson, FString& ResultJson);
};
