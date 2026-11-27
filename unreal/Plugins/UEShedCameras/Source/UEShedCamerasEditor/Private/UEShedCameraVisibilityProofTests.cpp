#if WITH_DEV_AUTOMATION_TESTS
#include "Animation/SkeletalMeshActor.h"
#include "AssetCompilingManager.h"
#include "Components/BillboardComponent.h"
#include "Components/BoxComponent.h"
#include "Components/ChildActorComponent.h"
#include "Components/InstancedStaticMeshComponent.h"
#include "Components/SceneCaptureComponent2D.h"
#include "Components/SkeletalMeshComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Editor.h"
#include "Engine/SkeletalMesh.h"
#include "Engine/StaticMesh.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/World.h"
#include "ImageUtils.h"
#include "LevelEditorViewport.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionConstant.h"
#include "Materials/MaterialExpressionConstant3Vector.h"
#include "Misc/AutomationTest.h"
#include "Misc/Paths.h"
#include "Misc/ScopeExit.h"
#include "SceneView.h"
#include "SceneViewExtension.h"
#include "UEShedCameraRenderSession.h"
#include "UEShedCameraVisibility.h"
#include "UEShedCameraEngine.h"
#include "UEShedTransientCapture.h"

namespace
{
/**
 * A magenta material of one blend mode, compiled before it is drawn. The editor compiles a
 * material's shaders on its first draw; until then a masked one draws as the opaque default and a
 * translucent one draws nothing, which would prove nothing about either.
 */
UMaterial *ProofMaterial(EBlendMode Mode)
{
    auto *Material = NewObject<UMaterial>(GetTransientPackage(), NAME_None, RF_Transient);
    Material->BlendMode = Mode;
    auto *Colour = NewObject<UMaterialExpressionConstant3Vector>(Material);
    Colour->Constant = FLinearColor(4, 0, 4);
    auto *One = NewObject<UMaterialExpressionConstant>(Material);
    One->R = 1;
    Material->GetExpressionCollection().AddExpression(Colour);
    Material->GetExpressionCollection().AddExpression(One);
    auto *Inputs = Material->GetEditorOnlyData();
    Inputs->EmissiveColor.Connect(0, Colour);
    if (Mode == BLEND_Masked)
        Inputs->OpacityMask.Connect(0, One);
    else if (Mode != BLEND_Opaque)
        Inputs->Opacity.Connect(0, One);
    Material->PostEditChange();
    Material->EnsureIsComplete();
    FAssetCompilingManager::Get().FinishAllCompilation();
    return Material;
}
} // namespace

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
    // Each kind of geometry stands alone on the same spot, high above the map, before one camera.
    const FVector Stage(0, 0, 50000);
    FActorSpawnParameters Spawn;
    Spawn.ObjectFlags = RF_Transient;
    Spawn.bTemporaryEditorActor = true;
    Spawn.bCreateActorPackage = false;
    TArray<AActor *> Spawned;
    ON_SCOPE_EXIT
    {
        for (AActor *Actor : Spawned)
            if (IsValid(Actor))
                W->DestroyActor(Actor, false, false);
    };
    auto *Cube = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube"));
    const auto Hiding = [](AActor *Actor) {
        auto Visibility = MakeShared<FJsonObject>();
        Visibility->SetArrayField(TEXT("hide"), {MakeShared<FJsonValueObject>(UEShedCameraActorEntry(Actor))});
        Visibility->SetArrayField(TEXT("protect"), {});
        return Visibility;
    };
    // Draws the actor visible, left out and visible again through both backends, and compares pixels.
    // `Magenta` also requires the visible frames to show the proof material's own colour.
    const auto Proves = [&](const TCHAR *Kind, AActor *Target, bool Magenta = false) {
        const auto Visibility = Hiding(Target);
        const auto Resolved = UEShedResolveCameraVisibility(W, Visibility);
        TestTrue(FString::Printf(TEXT("%s: resolves"), Kind), Resolved.Valid && Resolved.Hidden.Contains(Target));
        if (!Resolved.Valid)
        {
            AddError(FString::Printf(TEXT("%s: %s"), Kind, *Resolved.Message));
            return false;
        }
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
                const auto Frame = UEShedRenderFrame(
                    Session->Id(), FString::Printf(TEXT("proof-%d"), Pass),
                    UEShedCameraPose(Stage + FVector(800, 0, 0), FRotator(0, 180, 0), 60, false), 320, 180);
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
                TestFalse(FString::Printf(TEXT("%s: actor visibility never mutated"), Kind), Target->IsHiddenEd());
            }
            int64 Changed = 0, Restored = 0;
            for (int64 I = 0; I < Images[0].RawData.Num(); ++I)
            {
                if (FMath::Abs(int32(Images[0].RawData[I]) - int32(Images[1].RawData[I])) > 20)
                    ++Changed;
                if (FMath::Abs(int32(Images[0].RawData[I]) - int32(Images[2].RawData[I])) > 20)
                    ++Restored;
            }
            const TCHAR *Backend = Viewport ? TEXT("viewport") : TEXT("scene-capture");
            const auto Centre = [&](int32 Pass) {
                const int64 At = (int64(Images[Pass].SizeY / 2) * Images[Pass].SizeX + Images[Pass].SizeX / 2) * 4;
                return FString::Printf(TEXT("%d/%d/%d"), Images[Pass].RawData[At + 2], Images[Pass].RawData[At + 1],
                                       Images[Pass].RawData[At]);
            };
            AddInfo(FString::Printf(TEXT("%s, %s: changed=%lld restored-difference=%lld centre rgb %s -> %s -> %s"),
                                    Kind, Backend, Changed, Restored, *Centre(0), *Centre(1), *Centre(2)));
            if (Magenta)
            {
                const int64 At = (int64(Images[0].SizeY / 2) * Images[0].SizeX + Images[0].SizeX / 2) * 4;
                TestTrue(FString::Printf(TEXT("%s, %s: drawn with its own material"), Kind, Backend),
                         Images[0].RawData[At + 2] > Images[0].RawData[At + 1] + 40);
            }
            TestTrue(FString::Printf(TEXT("%s, %s: left out of actual pixels"), Kind, Backend), Changed > 1000);
            TestTrue(FString::Printf(TEXT("%s, %s: restoration matches visible reference"), Kind, Backend),
                     Restored < Changed / 10);
        }
        return true;
    };
    const auto Retire = [&](AActor *Actor) {
        Spawned.Remove(Actor);
        W->DestroyActor(Actor, false, false);
    };

    auto *Column = W->SpawnActor<AStaticMeshActor>(Stage, FRotator::ZeroRotator, Spawn);
    if (!Column || !Cube)
        return false;
    Spawned.Add(Column);
    auto *ColumnMesh = Column->GetStaticMeshComponent();
    ColumnMesh->SetStaticMesh(Cube);
    Column->SetActorScale3D(FVector(2, 2, 8));
    if (!Proves(TEXT("opaque static mesh"), Column))
        return false;

    auto *OriginalMaterial = ColumnMesh->GetMaterial(0);
    for (const auto Mode : {BLEND_Masked, BLEND_Translucent})
    {
        ColumnMesh->SetMaterial(0, ProofMaterial(Mode));
        TestEqual(TEXT("The proof material keeps its blend mode"), ColumnMesh->GetMaterial(0)->GetBlendMode(), Mode);
        if (!Proves(Mode == BLEND_Masked ? TEXT("masked material") : TEXT("translucent material"), Column, true))
            return false;
    }
    ColumnMesh->SetMaterial(0, OriginalMaterial);

    // What a Blueprint actor usually carries beside its mesh: a collision shape and an editor icon.
    auto *Box = NewObject<UBoxComponent>(Column, NAME_None, RF_Transient);
    auto *Icon = NewObject<UBillboardComponent>(Column, NAME_None, RF_Transient);
    for (USceneComponent *Extra : TArray<USceneComponent *>{Box, Icon})
    {
        Extra->SetupAttachment(ColumnMesh);
        Column->AddInstanceComponent(Extra);
        Extra->RegisterComponent();
    }
    if (!Proves(TEXT("mesh with a collision shape and an icon"), Column))
        return false;
    Box->DestroyComponent();
    Icon->DestroyComponent();

    auto Visibility = Hiding(Column);
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
    Visibility->SetArrayField(TEXT("protect"), {});
    Visibility->SetArrayField(TEXT("hide"), {MakeShared<FJsonValueObject>(Missing)});
    TestFalse(TEXT("Missing actors are explicit failures"), UEShedResolveCameraVisibility(W, Visibility).Valid);

    auto *NaniteMesh = DuplicateObject<UStaticMesh>(Cube, GetTransientPackage());
    NaniteMesh->SetFlags(RF_Transient);
    UEShedCameraEngine::NaniteSettings(NaniteMesh).bEnabled = true;
    ColumnMesh->SetStaticMesh(NaniteMesh);
    const auto Unsupported = UEShedResolveCameraVisibility(W, Hiding(Column));
    TestFalse(TEXT("Nanite-configured geometry is refused"), Unsupported.Valid);
    TestFalse(TEXT("Unsupported geometry explains its limitation"), Unsupported.Message.IsEmpty());
    ColumnMesh->SetStaticMesh(Cube);
    Retire(Column);

    auto *Empty = W->SpawnActor<AActor>(Stage, FRotator::ZeroRotator, Spawn);
    if (!Empty)
        return false;
    Spawned.Add(Empty);
    const auto Nothing = UEShedResolveCameraVisibility(W, Hiding(Empty));
    TestFalse(TEXT("An actor that draws nothing has nothing to leave out"), Nothing.Valid);
    TestFalse(TEXT("An actor that draws nothing is told so"), Nothing.Message.IsEmpty());
    Retire(Empty);

    auto *Holder = W->SpawnActor<AActor>(Stage, FRotator::ZeroRotator, Spawn);
    if (!Holder)
        return false;
    Spawned.Add(Holder);
    auto *Instances = NewObject<UInstancedStaticMeshComponent>(Holder, NAME_None, RF_Transient);
    Holder->SetRootComponent(Instances);
    Holder->AddInstanceComponent(Instances);
    Instances->SetStaticMesh(Cube);
    Instances->RegisterComponent();
    Instances->SetWorldLocation(Stage);
    Instances->AddInstance(FTransform(FRotator::ZeroRotator, FVector::ZeroVector, FVector(2, 2, 8)));
    if (!Proves(TEXT("instanced static mesh"), Holder))
        return false;
    Retire(Holder);

    auto *Skinned = W->SpawnActor<ASkeletalMeshActor>(Stage, FRotator::ZeroRotator, Spawn);
    auto *SkinnedCube = LoadObject<USkeletalMesh>(nullptr, TEXT("/Engine/EngineMeshes/SkeletalCube.SkeletalCube"));
    if (!Skinned || !SkinnedCube)
        return false;
    Spawned.Add(Skinned);
    Skinned->GetSkeletalMeshComponent()->SetSkeletalMeshAsset(SkinnedCube);
    Skinned->SetActorScale3D(FVector(150.0 / FMath::Max(1.0, SkinnedCube->GetBounds().BoxExtent.GetMax())));
    if (!Proves(TEXT("skeletal mesh"), Skinned))
        return false;
    Retire(Skinned);

    // A parent that draws only through the actor its child-actor component spawned.
    auto *Parent = W->SpawnActor<AActor>(Stage, FRotator::ZeroRotator, Spawn);
    if (!Parent)
        return false;
    Spawned.Add(Parent);
    auto *Root = NewObject<USceneComponent>(Parent, NAME_None, RF_Transient);
    Parent->SetRootComponent(Root);
    Root->RegisterComponent();
    Root->SetWorldLocation(Stage);
    auto *Slot = NewObject<UChildActorComponent>(Parent, NAME_None, RF_Transient);
    Slot->SetupAttachment(Root);
    Slot->SetChildActorClass(AStaticMeshActor::StaticClass());
    Parent->AddInstanceComponent(Slot);
    Slot->RegisterComponent();
    auto *Child = Cast<AStaticMeshActor>(Slot->GetChildActor());
    if (!Child)
    {
        AddError(TEXT("The child-actor component spawned no child."));
        return false;
    }
    Child->GetStaticMeshComponent()->SetStaticMesh(Cube);
    Child->SetActorScale3D(FVector(2, 2, 8));
    TestTrue(TEXT("Hiding a parent hides its child actors"),
             UEShedResolveCameraVisibility(W, Hiding(Parent)).Hidden.Contains(Child));
    if (!Proves(TEXT("child actor of the hidden actor"), Parent))
        return false;
    auto Kept = Hiding(Parent);
    Kept->SetArrayField(TEXT("protect"), {MakeShared<FJsonValueObject>(UEShedCameraActorEntry(Child))});
    TestFalse(TEXT("A protected child stays in"), UEShedResolveCameraVisibility(W, Kept).Hidden.Contains(Child));
    Retire(Parent);

    TestEqual(TEXT("Map dirt unchanged"), W->GetOutermost()->IsDirty(), Dirty);
    return true;
}
#endif
