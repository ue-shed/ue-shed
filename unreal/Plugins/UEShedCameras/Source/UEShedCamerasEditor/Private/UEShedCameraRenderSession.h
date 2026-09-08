#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

class UWorld;
class USceneCaptureComponent2D;

/** One editor-world renderer owner, shared by wire sessions and legacy workflow adapters. */
class FUEShedCameraRenderSession : public TSharedFromThis<FUEShedCameraRenderSession>
{
  public:
	static TSharedPtr<FUEShedCameraRenderSession> Open(const TSharedPtr<FJsonObject> &Request,
													   TSharedPtr<FJsonObject> &Error);
	static TSharedPtr<FJsonObject> Preflight(const TSharedPtr<FJsonObject> &Request);
	static TSharedPtr<FJsonObject> Capabilities();
	static bool IsBusy();
	static TSharedPtr<FUEShedCameraRenderSession> Find(const FString &SessionId);
	static void Shutdown();
	~FUEShedCameraRenderSession();
	TSharedPtr<FJsonObject> Start(const TSharedPtr<FJsonObject> &Frame);
	TSharedPtr<FJsonObject> Poll(const FString &OperationId, bool bRenewLease = true);
	TSharedPtr<FJsonObject> Close();
	TSharedPtr<FJsonObject> Reopen(const TSharedPtr<FJsonObject> &Request);
	TSharedPtr<FJsonObject> RenderBlocking(const TSharedPtr<FJsonObject> &Frame);
	TSharedPtr<FJsonObject> RenderConfiguredFrameBlocking(const FString &OperationId);
	void Tick(bool bDrawViewport = false);
	void Touch();
	bool IsClosed() const;
	const FString &Id() const;
	USceneCaptureComponent2D *SceneComponent() const;
	UWorld *World() const;
	TSharedPtr<FJsonObject> CurrentFrame() const;

  private:
	FUEShedCameraRenderSession();
	struct FState;
	TUniquePtr<FState> State;
};

TSharedPtr<FJsonObject> UEShedCameraJson(const FString &Text);
FString UEShedCameraJsonText(const TSharedPtr<FJsonObject> &Value);
TSharedPtr<FJsonObject> UEShedCameraContract();
TSharedPtr<FJsonObject> UEShedCameraPose(const FVector &Location, const FRotator &Rotation,
										 double ProjectionValue, bool bOrthographic);
TSharedPtr<FJsonObject> UEShedLegacyRenderRequest(const FString &Id, UWorld *World, bool bViewport,
												  const FString &Profile = TEXT("scene_capture_defaults"));
TSharedPtr<FJsonObject> UEShedRenderFrame(const FString &Session, const FString &Operation,
										  const TSharedPtr<FJsonObject> &Camera, int32 Width, int32 Height);
