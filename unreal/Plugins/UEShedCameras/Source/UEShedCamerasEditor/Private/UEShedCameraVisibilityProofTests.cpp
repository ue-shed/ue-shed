#if WITH_DEV_AUTOMATION_TESTS
#include "UEShedCameraRenderSession.h"
#include "UEShedTransientCapture.h"
#include "Components/StaticMeshComponent.h"
#include "Components/SceneCaptureComponent2D.h"
#include "Editor.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/World.h"
#include "ImageUtils.h"
#include "LevelEditorViewport.h"
#include "Misc/AutomationTest.h"
#include "Misc/Paths.h"
#include "Misc/ScopeExit.h"
#include "SceneView.h"
#include "SceneViewExtension.h"

namespace
{
// Deliberately a proof fixture, not an advertised renderer capability yet.
class FCameraVisibilityProof final : public FSceneViewExtensionBase
{
public:
	FCameraVisibilityProof(const FAutoRegister& Register) : FSceneViewExtensionBase(Register) {}
	FSceneViewStateInterface* Target = nullptr;
	TWeakObjectPtr<UStaticMeshComponent> Component;
	bool Enabled = false;
	int32 Applied = 0;
	void SetupView(FSceneViewFamily& Family, FSceneView& View) override
	{
		if (Enabled && Component.IsValid() && View.State == Target) { View.HiddenPrimitives.Add(Component->GetPrimitiveSceneId()); ++Applied; }
	}
};
}
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedCameraVisibilityProofTest, "UEShed.Cameras.Rendering.ViewLocalVisibilityProof",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FUEShedCameraVisibilityProofTest::RunTest(const FString& Parameters)
{
	auto* W = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
	auto* V = GCurrentLevelEditingViewportClient;
	if (!W || !V || !V->Viewport) { AddError(TEXT("Open a rendering editor fixture.")); return false; }
	const bool Dirty = W->GetOutermost()->IsDirty();
	FActorSpawnParameters Spawn; Spawn.ObjectFlags = RF_Transient; Spawn.bTemporaryEditorActor = true; Spawn.bCreateActorPackage = false;
	auto* Column = W->SpawnActor<AStaticMeshActor>(FVector(0, 0, 50000), FRotator::ZeroRotator, Spawn);
	if (!Column) return false;
	Column->GetStaticMeshComponent()->SetStaticMesh(LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube")));
	Column->SetActorScale3D(FVector(2, 2, 8));
	auto Extension = FSceneViewExtensions::NewExtension<FCameraVisibilityProof>();
	Extension->Target = V->ViewState.GetReference(); Extension->Component = Column->GetStaticMeshComponent();
	ON_SCOPE_EXIT { Extension->Enabled = false; W->DestroyActor(Column, false, false); };
	for (bool Viewport : {true, false})
	{
		auto Request = UEShedLegacyRenderRequest(FGuid::NewGuid().ToString(EGuidFormats::Digits), W, Viewport, TEXT("observation"));
		TSharedPtr<FJsonObject> Error; auto Session = FUEShedCameraRenderSession::Open(Request, Error);
		if (!Session) { AddError(UEShedCameraJsonText(Error)); return false; }
		ON_SCOPE_EXIT { Session->Close(); };
		TArray<FImage> Images;
		for (int32 Pass = 0; Pass < 3; ++Pass)
		{
			Extension->Enabled = !Viewport || Pass == 1;
			if (!Viewport && Session->SceneComponent()) { Session->SceneComponent()->HiddenActors.Reset(); if (Pass == 1) Session->SceneComponent()->HiddenActors.Add(Column); }
			const auto Frame = UEShedRenderFrame(Session->Id(), FString::Printf(TEXT("proof-%d"), Pass),
				UEShedCameraPose(FVector(800, 0, 50000), FRotator(0, 180, 0), 60, false), 320, 180);
			const auto Result = Session->RenderBlocking(Frame);
			if (Result->GetStringField(TEXT("status")) != TEXT("captured")) { AddError(UEShedCameraJsonText(Result)); return false; }
			const auto Path = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("UEShed/CameraRenderStaging"), Result->GetObjectField(TEXT("artifact"))->GetStringField(TEXT("relativePath")));
			FImage Image;
            if (!Viewport) {
                auto Capture = FUEShedTransientCapture::Create(W, FVector(800, 0, 50000), FRotator(0, 180, 0), 320, 180, TEXT("VisibilityProof"));
                if (!Capture) return false; Capture->ConfigurePerspective(60);
                if (Pass == 1) Capture->Component()->HiddenActors.Add(Column);
                for (int32 Warmup = 0; Warmup < 8; ++Warmup) Capture->Capture();
                if (!Capture->ReadImage(Image)) return false;
                FUEShedTransientCapture::WritePng(Path + TEXT(".direct.png"), Image);
            } else if (!FImageUtils::LoadImage(*Path, Image)) return false;
			Image.ChangeFormat(ERawImageFormat::BGRA8, EGammaSpace::sRGB); Images.Add(MoveTemp(Image));
			TestFalse(TEXT("Actor visibility never mutated"), Column->IsHiddenEd());
		}
		int64 Changed = 0, Restored = 0;
		for (int64 I = 0; I < Images[0].RawData.Num(); ++I)
		{
			if (FMath::Abs(int32(Images[0].RawData[I]) - int32(Images[1].RawData[I])) > 20) ++Changed;
			if (FMath::Abs(int32(Images[0].RawData[I]) - int32(Images[2].RawData[I])) > 20) ++Restored;
		}
		AddInfo(FString::Printf(TEXT("%s: changed=%lld restored-difference=%lld"), Viewport ? TEXT("viewport") : TEXT("scene-capture"), Changed, Restored));
		TestTrue(TEXT("Chosen column excluded in actual pixels"), Changed > 1000);
		TestTrue(TEXT("Restoration matches visible reference"), Restored < Changed / 10);
	}
	TestTrue(TEXT("Viewport-scoped hook ran"), Extension->Applied > 0);
	TestEqual(TEXT("Map dirt unchanged"), W->GetOutermost()->IsDirty(), Dirty);
	return true;
}
#endif
