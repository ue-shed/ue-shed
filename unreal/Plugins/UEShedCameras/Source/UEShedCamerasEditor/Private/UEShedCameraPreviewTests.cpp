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
#include "UEShedCameraPreviewReview.h"
#include "Components/ChildActorComponent.h"
#include "Engine/StaticMesh.h"
#include "StaticMeshCompiler.h"

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
    // Review snapshots say whether each shot shows its subject, with the review capture's depth comparison.
    {
        using EStatus = FUEShedCameraSubjectVisibility::EStatus;
        auto *Cube = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube"));
        if (!TestNotNull(TEXT("Engine cube"), Cube))
            return false;
        FStaticMeshCompilingManager::Get().FinishCompilation({Cube});
        TArray<AActor *> Spawned;
        ON_SCOPE_EXIT
        {
            for (auto *Actor : Spawned)
                World->DestroyActor(Actor, false, false);
        };
        const auto SpawnCube = [&](const FVector &Location, const FVector &Scale) {
            auto *Actor = World->SpawnActor<AStaticMeshActor>(Location, FRotator::ZeroRotator, Spawn);
            Actor->GetStaticMeshComponent()->SetStaticMesh(Cube);
            Actor->SetActorScale3D(Scale);
            Spawned.Add(Actor);
            return Actor;
        };
        // A 2 m subject in open sky. Cameras sit 8 m away on each axis, looking at it.
        const FVector S(0, 0, 60000);
        auto *Subject = SpawnCube(S, FVector(2));
        auto *Wall = SpawnCube(S + FVector(-400, 0, 0), FVector(.2, 6, 6));
        SpawnCube(S + FVector(50, -400, 0), FVector(1, .2, 4));
        // An editor-only owner whose ChildActorComponent previews what it will spawn, like a spawn volume.
        auto *Owner = World->SpawnActor<AActor>(S + FVector(0, 0, 3000), FRotator::ZeroRotator, Spawn);
        Spawned.Add(Owner);
        auto *Root = NewObject<USceneComponent>(Owner, TEXT("Root"), RF_Transient);
        Owner->SetRootComponent(Root);
        Root->RegisterComponent();
        Owner->SetActorLocation(S + FVector(0, 0, 3000));
        Owner->bIsEditorOnlyActor = true;
        auto *Preview = NewObject<UChildActorComponent>(Owner, TEXT("Preview"), RF_Transient);
        Preview->SetChildActorClass(AStaticMeshActor::StaticClass());
        Preview->SetupAttachment(Root);
        Preview->RegisterComponent();
        auto *Child = Cast<AStaticMeshActor>(Preview->GetChildActor());
        if (!TestNotNull(TEXT("The preview owner spawns its child"), Child))
            return false;
        Child->GetStaticMeshComponent()->SetStaticMesh(Cube);
        Child->SetActorScale3D(FVector(2));
        const auto Camera = [&](const TCHAR *Id, const FVector &Offset, double Yaw, AActor *Target) {
            FUEShedCameraPreviewView View;
            View.Id = Id;
            View.Location = Target->GetActorLocation() + Offset;
            View.Rotation = FRotator(0, Yaw, 0);
            View.FixedEV100 = 1;
            View.Subject = Target;
            return View;
        };
        TArray<FUEShedCameraPreviewView> SubjectViews{
            Camera(TEXT("clear"), FVector(0, 800, 0), -90, Subject),
            Camera(TEXT("partial"), FVector(0, -800, 0), 90, Subject),
            Camera(TEXT("blocked"), FVector(-800, 0, 0), 0, Subject),
            Camera(TEXT("excluded"), FVector(-800, 0, 0), 0, Subject),
            Camera(TEXT("away"), FVector(0, 800, 0), 90, Subject),
            Camera(TEXT("aside"), FVector(0, 800, 0), 0, Subject),
            Camera(TEXT("editor-only"), FVector(-800, 0, 0), 0, Owner),
            Camera(TEXT("editor-preview"), FVector(-800, 0, 0), 0, Owner)};
        SubjectViews[3].HiddenActors.Add(Wall);
        SubjectViews[7].EditorPreviews = true;
        FUEShedCameraPreviewReview Review;
        if (!TestTrue(TEXT("Begin a subject review"), Review.Begin(World, SubjectViews, Error)))
        {
            AddError(Error);
            return false;
        }
        int32 MostRevealed = 0;
        for (int32 I = 0; I < 256 && Review.IsRunning(); ++I)
        {
            Review.Tick(Time += .02);
            MostRevealed = FMath::Max(MostRevealed, Review.RevealedEditorPreviews());
        }
        TestFalse(TEXT("The subject review completes"), Review.IsRunning());
        const auto Status = [&](const TCHAR *Id) {
            const auto *Visibility = Review.SubjectVisibility(Id);
            return Visibility ? Visibility->Status : EStatus::NotChecked;
        };
        TestEqual(TEXT("A clear view shows the subject"), int32(Status(TEXT("clear"))), int32(EStatus::Visible));
        TestEqual(TEXT("A half-covered view reports the subject partly hidden"), int32(Status(TEXT("partial"))), int32(EStatus::Partial));
        const double Fraction = Review.SubjectVisibility(TEXT("partial"))->VisibleFraction;
        TestTrue(TEXT("Partial visibility reports the measured fraction"), Fraction > .2 && Fraction < .8);
        TestEqual(TEXT("A wall in front reports the subject blocked"), int32(Status(TEXT("blocked"))), int32(EStatus::Blocked));
        TestEqual(TEXT("Excluding the wall shows the subject"), int32(Status(TEXT("excluded"))), int32(EStatus::Visible));
        TestEqual(TEXT("Looking away reports the subject out of shot"), int32(Status(TEXT("away"))), int32(EStatus::OutOfShot));
        TestEqual(TEXT("A subject beside the camera is out of shot"), int32(Status(TEXT("aside"))), int32(EStatus::OutOfShot));
        TestEqual(TEXT("An editor-only preview does not render without editor previews"), int32(Status(TEXT("editor-only"))), int32(EStatus::NotRendered));
        TestEqual(TEXT("Editor previews reveal the preview, as capture does"), int32(Status(TEXT("editor-preview"))), int32(EStatus::Visible));
        TestTrue(TEXT("The review revealed the preview child while rendering"), MostRevealed >= 1);
        TestEqual(TEXT("Completing the review restores editor previews"), Review.RevealedEditorPreviews(), 0);
        TestTrue(TEXT("The preview child is editor-only again"), Child->IsEditorOnly());
        TestTrue(TEXT("The owner stays editor-only throughout"), Owner->IsEditorOnly());
        for (const auto &View : SubjectViews)
        {
            const auto *Thumbnail = Review.Thumbnail(View.Id);
            if (TestNotNull(TEXT("Each snapshot has a thumbnail from the same readback"), Thumbnail))
                TestEqual(TEXT("Thumbnails are small"), Thumbnail->GetSizeX(), FUEShedCameraPreviewReview::ThumbnailWidth);
        }
        Review.Reset();
        TestNull(TEXT("Reset releases thumbnails"), Review.Thumbnail(TEXT("clear")));
    }
    return true;
}
#endif
