#if WITH_DEV_AUTOMATION_TESTS
#include "Components/StaticMeshComponent.h"
#include "Editor.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/TextureRenderTarget2D.h"
#include "Engine/World.h"
#include "ImageUtils.h"
#include "LevelEditorViewport.h"
#include "Misc/AutomationTest.h"
#include "Misc/Paths.h"
#include "Misc/ScopeExit.h"
#include "UEShedCameraEditorOwnership.h"
#include "UEShedCameraPreviewPool.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedCameraPreviewTest, "UEShed.Cameras.Authoring.MultiCameraPreviews",
                                 EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEShedCameraPreviewTest::RunTest(const FString &Parameters)
{
    auto *World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    auto *Viewport = GCurrentLevelEditingViewportClient;
    if (!World || !Viewport)
    {
        AddError(TEXT("Open a rendering editor fixture."));
        return false;
    }
    const bool Dirty = World->GetOutermost()->IsDirty();
    const FVector BeforeLocation = Viewport->GetViewLocation();
    const FRotator BeforeRotation = Viewport->GetViewRotation();
    FActorSpawnParameters Spawn;
    Spawn.ObjectFlags = RF_Transient;
    Spawn.bTemporaryEditorActor = true;
    Spawn.bCreateActorPackage = false;
    auto *Column = World->SpawnActor<AStaticMeshActor>(FVector(0, 0, 50000), FRotator::ZeroRotator, Spawn);
    if (!Column)
        return false;
    Column->GetStaticMeshComponent()->SetStaticMesh(
        LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube")));
    Column->SetActorScale3D(FVector(2, 2, 8));
    ON_SCOPE_EXIT
    {
        World->DestroyActor(Column, false, false);
    };
    TArray<FUEShedCameraPreviewView> Views;
    for (int32 I = 0; I < 4; ++I)
    {
        FUEShedCameraPreviewView View;
        View.Id = FString::Printf(TEXT("camera-%d"), I);
        View.Location = FVector(800, 0, 50000);
        View.Rotation = FRotator(0, 180, 0);
        View.FixedEV100 = 1;
        if (I == 1)
            View.HiddenActors.Add(Column);
        if (I == 2)
            View.Rotation.Yaw = 90;
        if (I == 3)
            View.FieldOfView = 90;
        Views.Add(View);
    }
    TestTrue(TEXT("Previews coexist with the authoring lease"),
             FUEShedCameraEditorOwnership::TryAcquire(TEXT("preview-test")));
    ON_SCOPE_EXIT
    {
        FUEShedCameraEditorOwnership::Release(TEXT("preview-test"));
    };
    FUEShedCameraPreviewPool Pool;
    FString Error;
    if (!TestTrue(TEXT("Create four GPU previews"), Pool.SetViews(World, Views, Error)))
    {
        AddError(Error);
        return false;
    }
    TestEqual(TEXT("Bounded pool"), Pool.Num(), 4);
    double Time = 1;
    for (int32 I = 0; I < 32; ++I)
    {
        TestEqual(TEXT("Fair round-robin"), Pool.Tick(Time, true), Views[I % 4].Id);
        TestTrue(TEXT("No second capture in the same frame"), Pool.Tick(Time, true).IsEmpty());
        Time += .02;
    }
    TArray<FImage> Images;
    for (const auto &View : Views)
    {
        TestEqual(TEXT("All cameras refreshed"), Pool.Frames(View.Id), uint64(8));
        auto *Texture = Pool.Texture(View.Id);
        if (!TestNotNull(TEXT("GPU texture available"), Texture))
            return false;
        TestEqual(TEXT("Bounded width"), Texture->SizeX, 320);
        TestEqual(TEXT("Bounded height"), Texture->SizeY, 180);
        FImage Image;
        if (!TestTrue(TEXT("Read actual pixels"), FImageUtils::GetRenderTargetImage(Texture, Image)))
            return false;
        Image.ChangeFormat(ERawImageFormat::BGRA8, EGammaSpace::sRGB);
        const FString Path =
            FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("UEShed/PreviewValidation"), View.Id + TEXT(".png"));
        TestTrue(TEXT("Write preview proof"), FImageUtils::SaveImageByExtension(*Path, Image));
        Images.Add(MoveTemp(Image));
    }
    auto Difference = [](const FImage &A, const FImage &B) {
        int64 Changed = 0;
        for (int64 I = 0; I < FMath::Min(A.RawData.Num(), B.RawData.Num()); ++I)
            if (FMath::Abs(int32(A.RawData[I]) - int32(B.RawData[I])) > 20)
                ++Changed;
        return Changed;
    };
    TestTrue(TEXT("Per-camera exclusion changes actual pixels"), Difference(Images[0], Images[1]) > 1000);
    TestFalse(TEXT("Visibility never mutates the actor"), Column->IsHiddenEd());
    TestTrue(TEXT("Pause stops rendering"), Pool.Tick(Time, false).IsEmpty());
    Pool.RequestRefresh();
    TestFalse(TEXT("Manual refresh while paused"), Pool.Tick(Time, false).IsEmpty());
    Time += .02;
    const auto *FirstTexture = Pool.Texture(Views[0].Id);
    Views[0].FieldOfView = 45;
    TestTrue(TEXT("Update camera settings"), Pool.SetViews(World, Views, Error));
    TestTrue(TEXT("Reuse GPU target/history"), FirstTexture == Pool.Texture(Views[0].Id));
    Pool.UpdatePose(Views[0].Id, FVector(800, 0, 50000), FRotator(0, 90, 0), 45);
    for (int32 I = 0; I < 8; ++I)
    {
        Pool.Tick(Time, false);
        Time += .02;
    }
    FImage Moved;
    if (!TestTrue(TEXT("Read edited camera"), FImageUtils::GetRenderTargetImage(Pool.Texture(Views[0].Id), Moved)))
        return false;
    Moved.ChangeFormat(ERawImageFormat::BGRA8, EGammaSpace::sRGB);
    TestTrue(TEXT("Local pose edits update pixels"), Difference(Moved, Images[0]) > 1000);
    Views.RemoveAt(0);
    TestTrue(TEXT("Change page"), Pool.SetViews(World, Views, Error));
    TestNull(TEXT("Off-page texture released"), Pool.Texture(TEXT("camera-0")));
    TestEqual(TEXT("Viewport location unchanged"), Viewport->GetViewLocation(), BeforeLocation);
    TestEqual(TEXT("Viewport rotation unchanged"), Viewport->GetViewRotation(), BeforeRotation);
    TestEqual(TEXT("Map dirty state unchanged"), World->GetOutermost()->IsDirty(), Dirty);
    const auto Duplicate = Views[0];
    Views.Add(Duplicate);
    TestFalse(TEXT("Duplicate IDs rejected"), Pool.SetViews(World, Views, Error));
    TestEqual(TEXT("Invalid input clears stale images"), Pool.Num(), 0);
    Views.Reset();
    for (int32 I = 0; I < 5; ++I)
    {
        FUEShedCameraPreviewView View;
        View.Id = LexToString(I);
        Views.Add(View);
    }
    TestFalse(TEXT("Oversize pool rejected"), Pool.SetViews(World, Views, Error));
    Views.SetNum(1);
    TestTrue(TEXT("Restore valid preview"), Pool.SetViews(World, Views, Error));
    Pool.Reset();
    TestEqual(TEXT("Close releases all previews"), Pool.Num(), 0);
    TestTrue(TEXT("Closed pool cannot render"), Pool.Tick(Time, true).IsEmpty());
    return true;
}
#endif
