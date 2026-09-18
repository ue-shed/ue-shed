#if WITH_DEV_AUTOMATION_TESTS
#include "Components/SceneCaptureComponent2D.h"
#include "Components/StaticMeshComponent.h"
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
#include "UEShedCameraRenderSession.h"
#include "UEShedCameraVisibility.h"
#include "UEShedTransientCapture.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedCameraVisibilityProofTest, "UEShed.Cameras.Rendering.ViewLocalVisibilityProof",
                                 EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FUEShedCameraVisibilityProofTest::RunTest(const FString &Parameters)
{
    auto *W = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    auto *V = GCurrentLevelEditingViewportClient;
    if (!W || !V || !V->Viewport)
    {
        AddError(TEXT("Open a rendering editor fixture."));
        return false;
    }
    const bool Dirty = W->GetOutermost()->IsDirty();
    FActorSpawnParameters Spawn;
    Spawn.ObjectFlags = RF_Transient;
    Spawn.bTemporaryEditorActor = true;
    Spawn.bCreateActorPackage = false;
    auto *Column = W->SpawnActor<AStaticMeshActor>(FVector(0, 0, 50000), FRotator::ZeroRotator, Spawn);
    if (!Column)
        return false;
    Column->GetStaticMeshComponent()->SetStaticMesh(
        LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube")));
    Column->SetActorScale3D(FVector(2, 2, 8));
    ON_SCOPE_EXIT
    {
        W->DestroyActor(Column, false, false);
    };
    auto Visibility = MakeShared<FJsonObject>();
    Visibility->SetArrayField(TEXT("hide"), {MakeShared<FJsonValueObject>(UEShedCameraActorEntry(Column))});
    Visibility->SetArrayField(TEXT("protect"), {});
    auto Resolved = UEShedResolveCameraVisibility(W, Visibility);
    TestTrue(TEXT("Selected loaded opaque mesh resolves"), Resolved.Valid && Resolved.Hidden.Contains(Column));
    for (bool Viewport : {true, false})
    {
        TArray<FImage> Images;
        for (int32 Pass = 0; Pass < 3; ++Pass)
        {
            auto Request = UEShedLegacyRenderRequest(FGuid::NewGuid().ToString(EGuidFormats::Digits), W, Viewport,
                                                     TEXT("observation"));
            if (Pass == 1)
                Request->GetObjectField(TEXT("policy"))->SetObjectField(TEXT("visibility"), Visibility);
            TSharedPtr<FJsonObject> Error;
            auto Session = FUEShedCameraRenderSession::Open(Request, Error);
            if (!Session)
            {
                AddError(UEShedCameraJsonText(Error));
                return false;
            }
            ON_SCOPE_EXIT
            {
                Session->Close();
            };
            const auto Frame =
                UEShedRenderFrame(Session->Id(), FString::Printf(TEXT("proof-%d"), Pass),
                                  UEShedCameraPose(FVector(800, 0, 50000), FRotator(0, 180, 0), 60, false), 320, 180);
            const auto Result = Session->RenderBlocking(Frame);
            if (Result->GetStringField(TEXT("status")) != TEXT("captured"))
            {
                AddError(UEShedCameraJsonText(Result));
                return false;
            }
            const auto Path =
                FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("UEShed/CameraRenderStaging"),
                                Result->GetObjectField(TEXT("artifact"))->GetStringField(TEXT("relativePath")));
            FImage Image;
            if (!FImageUtils::LoadImage(*Path, Image))
                return false;
            Image.ChangeFormat(ERawImageFormat::BGRA8, EGammaSpace::sRGB);
            Images.Add(MoveTemp(Image));
            TestFalse(TEXT("Actor visibility never mutated"), Column->IsHiddenEd());
        }
        int64 Changed = 0, Restored = 0;
        for (int64 I = 0; I < Images[0].RawData.Num(); ++I)
        {
            if (FMath::Abs(int32(Images[0].RawData[I]) - int32(Images[1].RawData[I])) > 20)
                ++Changed;
            if (FMath::Abs(int32(Images[0].RawData[I]) - int32(Images[2].RawData[I])) > 20)
                ++Restored;
        }
        AddInfo(FString::Printf(TEXT("%s: changed=%lld restored-difference=%lld"),
                                Viewport ? TEXT("viewport") : TEXT("scene-capture"), Changed, Restored));
        TestTrue(TEXT("Chosen column excluded in actual pixels"), Changed > 1000);
        TestTrue(TEXT("Restoration matches visible reference"), Restored < Changed / 10);
    }
    Visibility->SetArrayField(TEXT("protect"), {MakeShared<FJsonValueObject>(UEShedCameraActorEntry(Column))});
    TestTrue(TEXT("Protection wins without mutating the actor"),
             UEShedResolveCameraVisibility(W, Visibility).Hidden.IsEmpty());
    auto Missing = MakeShared<FJsonObject>();
    auto MissingLocator = MakeShared<FJsonObject>();
    MissingLocator->SetStringField(TEXT("kind"), TEXT("actor_guid"));
    MissingLocator->SetStringField(TEXT("actorGuid"), FGuid::NewGuid().ToString(EGuidFormats::UniqueObjectGuid));
    MissingLocator->SetStringField(TEXT("lastKnownActorPath"), TEXT(""));
    Missing->SetObjectField(TEXT("locator"), MissingLocator);
    Missing->SetStringField(TEXT("label"), TEXT("Unloaded"));
    Visibility->SetArrayField(TEXT("hide"), {MakeShared<FJsonValueObject>(Missing)});
    TestFalse(TEXT("Missing actors are explicit failures"), UEShedResolveCameraVisibility(W, Visibility).Valid);
    TestEqual(TEXT("Map dirt unchanged"), W->GetOutermost()->IsDirty(), Dirty);
    return true;
}
#endif
