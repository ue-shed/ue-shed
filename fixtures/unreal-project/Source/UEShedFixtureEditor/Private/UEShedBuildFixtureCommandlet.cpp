#include "UEShedBuildFixtureCommandlet.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Algo/AnyOf.h"
#include "Animation/AnimData/IAnimationDataController.h"
#include "Animation/AnimSequence.h"
#include "Animation/Skeleton.h"
#include "Engine/CompositeDataTable.h"
#include "Engine/DataTable.h"
#include "Components/DirectionalLightComponent.h"
#include "Components/ExponentialHeightFogComponent.h"
#include "Components/SkyAtmosphereComponent.h"
#include "Components/SkyLightComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/DirectionalLight.h"
#include "Engine/ExponentialHeightFog.h"
#include "Engine/SkyLight.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/Texture2D.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "Factories/WorldFactory.h"
#include "GameFramework/PlayerStart.h"
#include "GameFramework/WorldSettings.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Materials/MaterialInterface.h"
#include "ReferenceSkeleton.h"
#include "HAL/FileManager.h"
#include "InputAction.h"
#include "InputActionValue.h"
#include "InputCoreTypes.h"
#include "InputMappingContext.h"
#include "InputModifiers.h"
#include "InputTriggers.h"
#include "Internationalization/StringTable.h"
#include "Internationalization/StringTableCore.h"
#include "Internationalization/Text.h"
#include "LevelSequence.h"
#include "MovieScene.h"
#include "MovieSceneBinding.h"
#include "MovieScenePossessable.h"
#include "Sections/MovieSceneCinematicShotSection.h"
#include "Sections/MovieSceneSubSection.h"
#include "Sections/MovieSceneTextSection.h"
#include "Tracks/MovieSceneCinematicShotTrack.h"
#include "Tracks/MovieSceneSubTrack.h"
#include "Tracks/MovieSceneTextTrack.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"
#include "Serialization/ArchiveSerializedPropertyChain.h"
#include "Serialization/JsonReader.h"
#include "Serialization/MemoryWriter.h"
#include "Serialization/StructuredArchiveAdapters.h"
#include "Serialization/JsonSerializer.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"
#include "UObject/UObjectHash.h"
#include "UObject/UnrealType.h"
#include "UEShedAuthoringLibrary.h"
#include "UEShedFixtureTypes.h"
#include "UEShedFixtureMover.h"
#include "UEShedCameraSource.h"
#include "UEShedMovementGym.h"

#include UE_INLINE_GENERATED_CPP_BY_NAME(UEShedBuildFixtureCommandlet)

namespace
{
constexpr int32 CameraFixtureCount = 32;
/** Dense World Scout catalog; cameras stay at CameraFixtureCount and bind to movers 0..31. */
constexpr int32 ObservationMoverCount = 4096;
constexpr int32 StationaryMoverCount = 3278;
constexpr int32 FlyingMoverCount = 409;
constexpr int32 IntermittentMoverCount = 409;
constexpr int32 LargeTableRowCount = 10000;
constexpr int32 OfflineWorldActorCount = 6;
constexpr int32 MapHistoryActorCount = 6;

struct FFixtureTableDefinition
{
	const TCHAR* AssetName;
	const TCHAR* PackageName;
	const TCHAR* SourcePath;
	UScriptStruct* RowStruct;
	int32 GeneratedRowCount = 0;
};

struct FFixtureTextureDefinition
{
	FString Name;
	FString ObjectPath;
	int32 Width = 0;
	int32 Height = 0;
	FString Pattern;
	TextureGroup Group = TEXTUREGROUP_World;
	TextureCompressionSettings Compression = TC_Default;
	bool bSRGB = true;
	TextureMipGenSettings MipGeneration = TMGS_FromTextureGroup;
};

bool ParseTextureGroup(const FString& Value, TextureGroup& Result)
{
	if (Value == TEXT("TEXTUREGROUP_World")) Result = TEXTUREGROUP_World;
	else if (Value == TEXT("TEXTUREGROUP_UI")) Result = TEXTUREGROUP_UI;
	else if (Value == TEXT("TEXTUREGROUP_Effects")) Result = TEXTUREGROUP_Effects;
	else return false;
	return true;
}

bool ParseTextureCompression(const FString& Value, TextureCompressionSettings& Result)
{
	if (Value == TEXT("TC_Default")) Result = TC_Default;
	else if (Value == TEXT("TC_EditorIcon")) Result = TC_EditorIcon;
	else return false;
	return true;
}

bool ParseMipGeneration(const FString& Value, TextureMipGenSettings& Result)
{
	if (Value == TEXT("TMGS_FromTextureGroup")) Result = TMGS_FromTextureGroup;
	else if (Value == TEXT("TMGS_NoMipmaps")) Result = TMGS_NoMipmaps;
	else return false;
	return true;
}

FString TextureGroupName(const TextureGroup Value)
{
	switch (Value)
	{
	case TEXTUREGROUP_World: return TEXT("TEXTUREGROUP_World");
	case TEXTUREGROUP_UI: return TEXT("TEXTUREGROUP_UI");
	case TEXTUREGROUP_Effects: return TEXT("TEXTUREGROUP_Effects");
	default: return FString::Printf(TEXT("unsupported:%d"), static_cast<int32>(Value));
	}
}

FString TextureCompressionName(const TextureCompressionSettings Value)
{
	switch (Value)
	{
	case TC_Default: return TEXT("TC_Default");
	case TC_EditorIcon: return TEXT("TC_EditorIcon");
	default: return FString::Printf(TEXT("unsupported:%d"), static_cast<int32>(Value));
	}
}

FString MipGenerationName(const TextureMipGenSettings Value)
{
	switch (Value)
	{
	case TMGS_FromTextureGroup: return TEXT("TMGS_FromTextureGroup");
	case TMGS_NoMipmaps: return TEXT("TMGS_NoMipmaps");
	default: return FString::Printf(TEXT("unsupported:%d"), static_cast<int32>(Value));
	}
}

bool LoadTextureDefinitions(TArray<FFixtureTextureDefinition>& Definitions)
{
	const FString Filename = FPaths::ConvertRelativePathToFull(
		FPaths::ProjectDir(), TEXT("FixtureSource/Audits/textures.json"));
	FString Json;
	if (!FFileHelper::LoadFileToString(Json, *Filename))
	{
		UE_LOG(LogTemp, Error, TEXT("Could not read texture fixture source %s"), *Filename);
		return false;
	}
	TArray<TSharedPtr<FJsonValue>> Values;
	if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Json), Values)) return false;
	for (const TSharedPtr<FJsonValue>& Value : Values)
	{
		const TSharedPtr<FJsonObject> Object = Value->AsObject();
		FFixtureTextureDefinition Definition;
		FString Format;
		FString Group;
		FString Compression;
		FString MipGeneration;
		if (!Object.IsValid()
			|| !Object->TryGetStringField(TEXT("name"), Definition.Name)
			|| !Object->TryGetStringField(TEXT("objectPath"), Definition.ObjectPath)
			|| !Object->TryGetNumberField(TEXT("width"), Definition.Width)
			|| !Object->TryGetNumberField(TEXT("height"), Definition.Height)
			|| !Object->TryGetStringField(TEXT("sourceFormat"), Format)
			|| !Object->TryGetStringField(TEXT("pattern"), Definition.Pattern)
			|| !Object->TryGetStringField(TEXT("textureGroup"), Group)
			|| !Object->TryGetStringField(TEXT("compression"), Compression)
			|| !Object->TryGetBoolField(TEXT("sRGB"), Definition.bSRGB)
			|| !Object->TryGetStringField(TEXT("mipGeneration"), MipGeneration)
			|| Format != TEXT("TSF_BGRA8")
			|| (Definition.Pattern != TEXT("checker") && Definition.Pattern != TEXT("stripes"))
			|| !ParseTextureGroup(Group, Definition.Group)
			|| !ParseTextureCompression(Compression, Definition.Compression)
			|| !ParseMipGeneration(MipGeneration, Definition.MipGeneration)
			|| Definition.Width <= 0 || Definition.Height <= 0)
		{
			UE_LOG(LogTemp, Error, TEXT("Invalid or unsupported texture fixture definition"));
			return false;
		}
		Definitions.Add(MoveTemp(Definition));
	}
	return Definitions.Num() == 17;
}

TArray<FFixtureTableDefinition> GetTableDefinitions()
{
	return {
		{ TEXT("DT_Scalars"), TEXT("/Game/Fixture/Authoring/DT_Scalars"),
			TEXT("FixtureSource/Authoring/DT_Scalars.json"),
			FUEShedFixtureScalarsRow::StaticStruct() },
		{ TEXT("DT_ScalarsOverride"), TEXT("/Game/Fixture/Authoring/DT_ScalarsOverride"),
			TEXT("FixtureSource/Authoring/DT_ScalarsOverride.json"),
			FUEShedFixtureScalarsRow::StaticStruct() },
		{ TEXT("DT_Enums"), TEXT("/Game/Fixture/Authoring/DT_Enums"),
			TEXT("FixtureSource/Authoring/DT_Enums.json"), FUEShedFixtureEnumRow::StaticStruct() },
		{ TEXT("DT_Structs"), TEXT("/Game/Fixture/Authoring/DT_Structs"),
			TEXT("FixtureSource/Authoring/DT_Structs.json"), FUEShedFixtureStructRow::StaticStruct() },
		{ TEXT("DT_Text"), TEXT("/Game/Fixture/Authoring/DT_Text"),
			TEXT("FixtureSource/Authoring/DT_Text.json"), FUEShedFixtureTextRow::StaticStruct() },
		{ TEXT("DT_AssetReferences"), TEXT("/Game/Fixture/Authoring/DT_AssetReferences"),
			TEXT("FixtureSource/Authoring/DT_AssetReferences.json"),
			FUEShedFixtureAssetReferenceRow::StaticStruct() },
		{ TEXT("DT_RightReferences"), TEXT("/Game/Fixture/Authoring/DT_RightReferences"),
			TEXT("FixtureSource/Authoring/DT_RightReferences.json"),
			FUEShedFixtureRightReferenceRow::StaticStruct() },
		{ TEXT("DT_LeftReferences"), TEXT("/Game/Fixture/Authoring/DT_LeftReferences"),
			TEXT("FixtureSource/Authoring/DT_LeftReferences.json"),
			FUEShedFixtureLeftReferenceRow::StaticStruct() },
		{ TEXT("DT_Containers"), TEXT("/Game/Fixture/Authoring/DT_Containers"),
			TEXT("FixtureSource/Authoring/DT_Containers.json"),
			FUEShedFixtureContainerRow::StaticStruct() },
		{ TEXT("DT_Opaque"), TEXT("/Game/Fixture/Authoring/DT_Opaque"),
			TEXT("FixtureSource/Authoring/DT_Opaque.json"), FUEShedFixtureOpaqueRow::StaticStruct() },
		{ TEXT("DT_LargeScalars"), TEXT("/Game/Fixture/Authoring/DT_LargeScalars"), nullptr,
			FUEShedFixtureScalarsRow::StaticStruct(), LargeTableRowCount }
	};
}

FString ObjectPath(const FFixtureTableDefinition& Definition)
{
	return FString::Printf(TEXT("%s.%s"), Definition.PackageName, Definition.AssetName);
}

bool SaveAsset(UPackage* Package, UObject* Asset)
{
	const FString Filename = FPackageName::LongPackageNameToFilename(
		Package->GetName(), Asset->IsA<UWorld>()
			? FPackageName::GetMapPackageExtension()
			: FPackageName::GetAssetPackageExtension());
	IFileManager::Get().MakeDirectory(*FPaths::GetPath(Filename), true);

	FSavePackageArgs SaveArgs;
	SaveArgs.TopLevelFlags = RF_Public | RF_Standalone;
	SaveArgs.SaveFlags = SAVE_NoError;
	return UPackage::SavePackage(Package, Asset, *Filename, SaveArgs);
}

FString PackageFilename(const FString& PackageName, const bool bMap)
{
	if (PackageName.StartsWith(TEXT("/Game/")))
	{
		const FString ProjectDirectory = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir());
		return FPaths::Combine(ProjectDirectory, TEXT("Content"), PackageName.RightChop(6))
			+ (bMap ? FPackageName::GetMapPackageExtension()
				: FPackageName::GetAssetPackageExtension());
	}
	return FPackageName::LongPackageNameToFilename(
		PackageName, bMap ? FPackageName::GetMapPackageExtension()
			: FPackageName::GetAssetPackageExtension());
}

TArray<FString> PackageFiles(const FString& PackageName, const bool bMap)
{
	const FString Primary = FPaths::ConvertRelativePathToFull(PackageFilename(PackageName, bMap));
	const FString Base = FPaths::Combine(
		FPaths::GetPath(Primary), FPaths::GetBaseFilename(Primary));
	const TCHAR* PrimaryExtension = bMap ? TEXT(".umap") : TEXT(".uasset");
	TArray<FString> Files;
	for (const TCHAR* Extension : { PrimaryExtension, TEXT(".uexp"), TEXT(".ubulk"),
		TEXT(".m.ubulk"), TEXT(".uptnl") })
	{
		const FString Filename = Base + Extension;
		if (IFileManager::Get().FileExists(*Filename)) Files.Add(Filename);
	}
	return Files;
}

bool DeletePackageFiles(const FString& PackageName, const bool bMap)
{
	bool bSucceeded = true;
	for (const FString& Filename : PackageFiles(PackageName, bMap))
	{
		bSucceeded = IFileManager::Get().Delete(*Filename, false, true, true) && bSucceeded;
	}
	return bSucceeded;
}

FString ProjectRelativePath(const FString& Filename)
{
	FString Relative = FPaths::ConvertRelativePathToFull(Filename);
	const FString ProjectDirectory = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir());
	if (!FPaths::MakePathRelativeTo(Relative, *ProjectDirectory))
	{
		UE_LOG(LogTemp, Error, TEXT("Could not resolve fixture package %s beneath %s"),
			*Filename, *ProjectDirectory);
		return FString();
	}
	return Relative.Replace(TEXT("\\"), TEXT("/"));
}

bool CopyFixtureFile(const FString& Source, const FString& RevisionDirectory)
{
	const FString Relative = ProjectRelativePath(Source);
	if (Relative.IsEmpty()) return false;
	const FString Destination = FPaths::Combine(RevisionDirectory, Relative);
	IFileManager::Get().MakeDirectory(*FPaths::GetPath(Destination), true);
	const uint32 CopyResult = IFileManager::Get().Copy(*Destination, *Source, true, true);
	if (CopyResult != COPY_OK)
	{
		UE_LOG(LogTemp, Error, TEXT("Could not copy fixture package %s to %s (result %u)"),
			*Source, *Destination, CopyResult);
		return false;
	}
	return true;
}

bool CopyPackageFiles(const FString& PackageName, const bool bMap, const FString& RevisionDirectory)
{
	const TArray<FString> Files = PackageFiles(PackageName, bMap);
	if (Files.IsEmpty())
	{
		UE_LOG(LogTemp, Error, TEXT("Could not find fixture package files for %s at %s"),
			*PackageName, *PackageFilename(PackageName, bMap));
		return false;
	}
	bool bSucceeded = true;
	for (const FString& Filename : Files)
	{
		bSucceeded = CopyFixtureFile(Filename, RevisionDirectory) && bSucceeded;
	}
	return bSucceeded;
}

UPackage* FindOrCreatePackage(const TCHAR* PackageName)
{
	FString ExistingFilename;
	if (FPackageName::DoesPackageExist(PackageName, &ExistingFilename))
	{
		return LoadPackage(nullptr, PackageName, LOAD_None);
	}

	return CreatePackage(PackageName);
}

TSharedRef<FJsonObject> EvidenceContract()
{
	const TSharedRef<FJsonObject> Contract = MakeShared<FJsonObject>();
	Contract->SetStringField(TEXT("name"), TEXT("ue-shed-unreal-asset-evidence"));
	const TSharedRef<FJsonObject> Version = MakeShared<FJsonObject>();
	Version->SetNumberField(TEXT("major"), 1);
	Version->SetNumberField(TEXT("minor"), 0);
	Contract->SetObjectField(TEXT("version"), Version);
	return Contract;
}


TSharedRef<FJsonObject> EvidenceRoot(const TCHAR* AssetType, const UObject* Asset)
{
	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetObjectField(TEXT("contract"), EvidenceContract());
	Root->SetStringField(TEXT("assetType"), AssetType);
	Root->SetStringField(TEXT("objectPath"), Asset->GetPathName());
	Root->SetStringField(TEXT("classPath"), Asset->GetClass()->GetPathName());
	return Root;
}

bool WriteJsonEvidence(const FString& Filename, const TSharedRef<FJsonObject>& Evidence)
{
	FString Json;
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Json);
	if (!FJsonSerializer::Serialize(Evidence, Writer)) return false;
	IFileManager::Get().MakeDirectory(*FPaths::GetPath(Filename), true);
	return FFileHelper::SaveStringToFile(Json + LINE_TERMINATOR, *Filename,
		FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
}

TArray<uint8> GenerateTexturePixels(const FFixtureTextureDefinition& Definition)
{
	TArray<uint8> Pixels;
	Pixels.SetNumUninitialized(Definition.Width * Definition.Height * 4);
	for (int32 Y = 0; Y < Definition.Height; ++Y)
	{
		for (int32 X = 0; X < Definition.Width; ++X)
		{
			const bool bAccent = Definition.Pattern == TEXT("checker")
				? ((X / 16) + (Y / 16)) % 2 == 0
				: (X / 24) % 2 == 0;
			const int32 Offset = (Y * Definition.Width + X) * 4;
			Pixels[Offset] = bAccent ? 42 : 188;
			Pixels[Offset + 1] = bAccent ? 166 : 55;
			Pixels[Offset + 2] = bAccent ? 232 : 28;
			Pixels[Offset + 3] = 255;
		}
	}
	return Pixels;
}

bool GenerateAuditTextures()
{
	TArray<FFixtureTextureDefinition> Definitions;
	if (!LoadTextureDefinitions(Definitions)) return false;
	bool bSucceeded = true;
	for (const FFixtureTextureDefinition& Definition : Definitions)
	{
		const FString PackageName = FPackageName::ObjectPathToPackageName(Definition.ObjectPath);
		UPackage* Package = FindOrCreatePackage(*PackageName);
		if (Package == nullptr)
		{
			bSucceeded = false;
			continue;
		}
		UTexture2D* Texture = FindObject<UTexture2D>(Package, *Definition.Name);
		const bool bWasCreated = Texture == nullptr;
		if (bWasCreated)
		{
			Texture = NewObject<UTexture2D>(Package, *Definition.Name,
				RF_Public | RF_Standalone | RF_Transactional);
		}
		const TArray<uint8> Pixels = GenerateTexturePixels(Definition);
		Texture->PreEditChange(nullptr);
		Texture->Source.Init(Definition.Width, Definition.Height, 1, 1, TSF_BGRA8, Pixels.GetData());
		Texture->LODGroup = Definition.Group;
		Texture->CompressionSettings = Definition.Compression;
		Texture->SRGB = Definition.bSRGB;
		Texture->MipGenSettings = Definition.MipGeneration;
		Texture->PostEditChange();
		if (bWasCreated) FAssetRegistryModule::AssetCreated(Texture);
		Package->MarkPackageDirty();
		if (!SaveAsset(Package, Texture))
		{
			UE_LOG(LogTemp, Error, TEXT("Could not save %s"), *PackageName);
			bSucceeded = false;
		}
		else
		{
			UE_LOG(LogTemp, Display, TEXT("Generated %s (%dx%d)"),
				*Definition.ObjectPath, Definition.Width, Definition.Height);
		}
	}
	return bSucceeded;
}

bool VerifyAuditTextures()
{
	TArray<FFixtureTextureDefinition> Definitions;
	if (!LoadTextureDefinitions(Definitions)) return false;
	bool bSucceeded = true;
	for (const FFixtureTextureDefinition& Definition : Definitions)
	{
		const UTexture2D* Texture = LoadObject<UTexture2D>(nullptr, *Definition.ObjectPath);
		const bool bMatches = Texture != nullptr
			&& Texture->Source.GetSizeX() == Definition.Width
			&& Texture->Source.GetSizeY() == Definition.Height
			&& Texture->Source.GetNumSlices() == 1
			&& Texture->Source.GetNumMips() == 1
			&& Texture->Source.GetFormat() == TSF_BGRA8
			&& Texture->LODGroup == Definition.Group
			&& Texture->CompressionSettings == Definition.Compression
			&& Texture->SRGB == Definition.bSRGB
			&& Texture->MipGenSettings == Definition.MipGeneration;
		if (!bMatches)
		{
			UE_LOG(LogTemp, Error, TEXT("Texture fixture does not match: %s"),
				*Definition.ObjectPath);
			bSucceeded = false;
		}
	}
	UE_LOG(LogTemp, Display, TEXT("Texture fixture verification checked %d assets"),
		Definitions.Num());
	return bSucceeded;
}

bool GenerateAnimationFixtures()
{
	constexpr const TCHAR* SkeletonPackageName = TEXT("/Game/Fixture/Animation/SK_Fixture");
	constexpr const TCHAR* SkeletonAssetName = TEXT("SK_Fixture");
	UPackage* SkeletonPackage = FindOrCreatePackage(SkeletonPackageName);
	if (SkeletonPackage == nullptr) return false;
	USkeleton* Skeleton = FindObject<USkeleton>(SkeletonPackage, SkeletonAssetName);
	const bool bSkeletonCreated = Skeleton == nullptr;
	if (bSkeletonCreated)
	{
		Skeleton = NewObject<USkeleton>(SkeletonPackage, SkeletonAssetName,
			RF_Public | RF_Standalone | RF_Transactional);
		FReferenceSkeletonModifier Modifier(Skeleton);
		Modifier.Add(FMeshBoneInfo(TEXT("root"), TEXT("root"), INDEX_NONE), FTransform::Identity);
		Modifier.Add(FMeshBoneInfo(TEXT("hand"), TEXT("hand"), 0),
			FTransform(FQuat::Identity, FVector(0.0, 0.0, 50.0)));
		FAssetRegistryModule::AssetCreated(Skeleton);
	}
	SkeletonPackage->MarkPackageDirty();
	if (!SaveAsset(SkeletonPackage, Skeleton)) return false;

	constexpr const TCHAR* SequencePackageName = TEXT("/Game/Fixture/Animation/A_FixtureMotion");
	constexpr const TCHAR* SequenceAssetName = TEXT("A_FixtureMotion");
	UPackage* SequencePackage = FindOrCreatePackage(SequencePackageName);
	if (SequencePackage == nullptr) return false;
	UAnimSequence* Sequence = FindObject<UAnimSequence>(SequencePackage, SequenceAssetName);
	const bool bSequenceCreated = Sequence == nullptr;
	if (bSequenceCreated)
	{
		Sequence = NewObject<UAnimSequence>(SequencePackage, SequenceAssetName,
			RF_Public | RF_Standalone | RF_Transactional);
		FAssetRegistryModule::AssetCreated(Sequence);
	}

	Sequence->SetSkeleton(Skeleton);
	Sequence->RateScale = 1.25f;
	Sequence->bLoop = true;
	Sequence->bEnableRootMotion = true;
	Sequence->RootMotionRootLock = ERootMotionRootLock::AnimFirstFrame;
	Sequence->bForceRootLock = true;
	Sequence->bUseNormalizedRootMotionScale = false;

	IAnimationDataController& Controller = Sequence->GetController();
	Controller.InitializeModel();
	Controller.OpenBracket(NSLOCTEXT("UEShedFixture", "BuildAnimation", "Build animation fixture"),
		false);
	Controller.ResetModel(false);
	Controller.SetFrameRate(FFrameRate(30, 1), false);
	Controller.SetNumberOfFrames(FFrameNumber(60), false);

	TArray<FVector3f> RootPositions;
	TArray<FQuat4f> RootRotations;
	TArray<FVector3f> RootScales;
	RootPositions.Reserve(61);
	RootRotations.Reserve(61);
	RootScales.Reserve(61);
	for (int32 Key = 0; Key <= 60; ++Key)
	{
		RootPositions.Add(FVector3f(static_cast<float>(Key) * 2.0f, 0.0f, 0.0f));
		RootRotations.Add(FQuat4f::Identity);
		RootScales.Add(FVector3f::OneVector);
	}
	Controller.AddBoneCurve(TEXT("root"), false);
	Controller.SetBoneTrackKeys(TEXT("root"), RootPositions, RootRotations, RootScales, false);

	Controller.AddBoneCurve(TEXT("hand"), false);
	Controller.SetBoneTrackKeys(TEXT("hand"),
		{ FVector3f(0.0f, 0.0f, 50.0f), FVector3f(0.0f, 10.0f, 50.0f) },
		{ FQuat4f::Identity, FQuat4f(FVector3f::UpVector, FMath::DegreesToRadians(30.0f)) },
		{ FVector3f::OneVector, FVector3f::OneVector }, false);
	Controller.NotifyPopulated();
	Controller.CloseBracket(false);

	SequencePackage->MarkPackageDirty();
	if (!SaveAsset(SequencePackage, Sequence)) return false;
	UE_LOG(LogTemp, Display, TEXT("Generated %s and %s"), SkeletonPackageName,
		SequencePackageName);
	return true;
}

bool VerifyAnimationFixtures()
{
	const USkeleton* Skeleton = LoadObject<USkeleton>(
		nullptr, TEXT("/Game/Fixture/Animation/SK_Fixture.SK_Fixture"));
	const UAnimSequence* Sequence = LoadObject<UAnimSequence>(
		nullptr, TEXT("/Game/Fixture/Animation/A_FixtureMotion.A_FixtureMotion"));
	return Skeleton != nullptr
		&& Skeleton->GetReferenceSkeleton().GetNum() == 2
		&& Sequence != nullptr
		&& Sequence->GetSkeleton() == Skeleton
		&& Sequence->GetDataModel()->GetFrameRate() == FFrameRate(30, 1)
		&& Sequence->GetDataModel()->GetNumberOfFrames() == 60
		&& Sequence->GetDataModel()->GetNumBoneTracks() == 2
		&& FMath::IsNearlyEqual(Sequence->GetPlayLength(), 2.0f)
		&& FMath::IsNearlyEqual(Sequence->RateScale, 1.25f)
		&& Sequence->bLoop
		&& Sequence->bEnableRootMotion;
}

bool GenerateLevelSequenceFixture()
{
	constexpr const TCHAR* PackageName = TEXT("/Game/Fixture/Sequences/LS_TextTimeline");
	constexpr const TCHAR* AssetName = TEXT("LS_TextTimeline");
	UPackage* Package = FindOrCreatePackage(PackageName);
	if (Package == nullptr) return false;
	ULevelSequence* Sequence = FindObject<ULevelSequence>(Package, AssetName);
	const bool bCreated = Sequence == nullptr;
	if (bCreated)
	{
		Sequence = NewObject<ULevelSequence>(Package, AssetName,
			RF_Public | RF_Standalone | RF_Transactional);
		Sequence->Initialize();
		FAssetRegistryModule::AssetCreated(Sequence);

		UMovieScene* MovieScene = Sequence->GetMovieScene();
		MovieScene->SetTickResolutionDirectly(FFrameRate(24000, 1));
		MovieScene->SetDisplayRate(FFrameRate(24, 1));
		MovieScene->SetPlaybackRange(FFrameNumber(0), 120000);

		const FGuid Binding = MovieScene->AddPossessable(
			TEXT("Localized dialogue"), UUEShedFixtureTextAsset::StaticClass());
		UMovieSceneTextTrack* Track = MovieScene->AddTrack<UMovieSceneTextTrack>(Binding);
		if (Track == nullptr) return false;
		Track->SetPropertyNameAndPath(TEXT("SharedPrimary"), TEXT("SharedPrimary"));

		UMovieSceneTextSection* Section = Cast<UMovieSceneTextSection>(Track->CreateNewSection());
		if (Section == nullptr) return false;
		Section->SetRange(TRange<FFrameNumber>(FFrameNumber(0), FFrameNumber(120000)));
		Track->AddSection(*Section);

		FMovieSceneTextChannel* Channel =
			Section->GetChannelProxy().GetChannel<FMovieSceneTextChannel>(0);
		if (Channel == nullptr) return false;
		Channel->SetPackage(Package);
		Channel->AddKeys(
			{ FFrameNumber(0), FFrameNumber(48000), FFrameNumber(96000) },
			{
				FText::ChangeKey(FTextKey(TEXT("Fixture.Cutscene")),
					FTextKey(TEXT("Opening")), FText::FromString(TEXT("We made it."))),
				FText::ChangeKey(FTextKey(TEXT("Fixture.Cutscene")),
					FTextKey(TEXT("Warning")), FText::FromString(TEXT("Something is wrong."))),
				FText::ChangeKey(FTextKey(TEXT("Fixture.Cutscene")),
					FTextKey(TEXT("Exit")), FText::FromString(TEXT("Run!")))
			});
	}

	Package->MarkPackageDirty();
	if (!SaveAsset(Package, Sequence)) return false;
	UE_LOG(LogTemp, Display, TEXT("Generated %s"), PackageName);
	return true;
}

bool GenerateNestedLevelSequenceFixture()
{
	constexpr const TCHAR* PackageName = TEXT("/Game/Fixture/Sequences/LS_NestedTimeline");
	constexpr const TCHAR* AssetName = TEXT("LS_NestedTimeline");
	ULevelSequence* ChildSequence = LoadObject<ULevelSequence>(
		nullptr, TEXT("/Game/Fixture/Sequences/LS_TextTimeline.LS_TextTimeline"));
	if (ChildSequence == nullptr) return false;

	UPackage* Package = FindOrCreatePackage(PackageName);
	if (Package == nullptr) return false;
	ULevelSequence* Sequence = FindObject<ULevelSequence>(Package, AssetName);
	if (Sequence == nullptr)
	{
		Sequence = NewObject<ULevelSequence>(Package, AssetName,
			RF_Public | RF_Standalone | RF_Transactional);
		Sequence->Initialize();
		FAssetRegistryModule::AssetCreated(Sequence);

		UMovieScene* MovieScene = Sequence->GetMovieScene();
		MovieScene->SetTickResolutionDirectly(FFrameRate(24000, 1));
		MovieScene->SetDisplayRate(FFrameRate(24, 1));
		MovieScene->SetPlaybackRange(FFrameNumber(0), 120000);

		UMovieSceneSubTrack* SubTrack = MovieScene->AddTrack<UMovieSceneSubTrack>();
		if (SubTrack == nullptr
			|| SubTrack->AddSequence(ChildSequence, FFrameNumber(0), 60000) == nullptr)
		{
			return false;
		}

		UMovieSceneCinematicShotTrack* ShotTrack =
			MovieScene->AddTrack<UMovieSceneCinematicShotTrack>();
		if (ShotTrack == nullptr) return false;
		UMovieSceneCinematicShotSection* ShotSection =
			Cast<UMovieSceneCinematicShotSection>(
				ShotTrack->AddSequence(ChildSequence, FFrameNumber(60000), 60000));
		if (ShotSection == nullptr) return false;
		ShotSection->SetShotDisplayName(TEXT("Text timeline reprise"));
	}

	Package->MarkPackageDirty();
	if (!SaveAsset(Package, Sequence)) return false;
	UE_LOG(LogTemp, Display, TEXT("Generated %s"), PackageName);
	return true;
}

bool VerifyLevelSequenceFixture()
{
	const ULevelSequence* Sequence = LoadObject<ULevelSequence>(
		nullptr, TEXT("/Game/Fixture/Sequences/LS_TextTimeline.LS_TextTimeline"));
	if (Sequence == nullptr || Sequence->GetMovieScene() == nullptr) return false;
	const UMovieScene* MovieScene = Sequence->GetMovieScene();
	if (MovieScene->GetTickResolution() != FFrameRate(24000, 1)
		|| MovieScene->GetDisplayRate() != FFrameRate(24, 1)
		|| MovieScene->GetPlaybackRange() !=
			TRange<FFrameNumber>(FFrameNumber(0), FFrameNumber(120000))
		|| MovieScene->GetPossessableCount() != 1
		|| MovieScene->GetBindings().Num() != 1)
	{
		return false;
	}

	const TArray<UMovieSceneTrack*> Tracks = MovieScene->GetBindings()[0].GetTracks();
	if (Tracks.Num() != 1) return false;
	const UMovieSceneTextTrack* Track = Cast<UMovieSceneTextTrack>(Tracks[0]);
	if (Track == nullptr || Track->GetAllSections().Num() != 1) return false;
	const UMovieSceneTextSection* Section =
		Cast<UMovieSceneTextSection>(Track->GetAllSections()[0]);
	if (Section == nullptr || Section->GetChannel().GetTimes()
		!= TArray<FFrameNumber>({ FFrameNumber(0), FFrameNumber(48000), FFrameNumber(96000) }))
	{
		return false;
	}
	const TMovieSceneChannelData<const FText> ChannelData = Section->GetChannel().GetData();
	const TArrayView<const FText> Values = ChannelData.GetValues();
	const bool bTextTimelineValid = Values.Num() == 3
		&& Values[0].ToString() == TEXT("We made it.")
		&& Values[1].ToString() == TEXT("Something is wrong.")
		&& Values[2].ToString() == TEXT("Run!");
	if (!bTextTimelineValid) return false;

	const ULevelSequence* NestedSequence = LoadObject<ULevelSequence>(
		nullptr, TEXT("/Game/Fixture/Sequences/LS_NestedTimeline.LS_NestedTimeline"));
	if (NestedSequence == nullptr || NestedSequence->GetMovieScene() == nullptr) return false;
	const TArray<UMovieSceneTrack*>& RootTracks = NestedSequence->GetMovieScene()->GetTracks();
	if (RootTracks.Num() != 2) return false;
	const UMovieSceneSubTrack* SubTrack = Cast<UMovieSceneSubTrack>(RootTracks[0]);
	const UMovieSceneCinematicShotTrack* ShotTrack =
		Cast<UMovieSceneCinematicShotTrack>(RootTracks[1]);
	if (SubTrack == nullptr || SubTrack->GetAllSections().Num() != 1
		|| ShotTrack == nullptr || ShotTrack->GetAllSections().Num() != 1)
	{
		return false;
	}
	const UMovieSceneSubSection* SubSection =
		Cast<UMovieSceneSubSection>(SubTrack->GetAllSections()[0]);
	const UMovieSceneCinematicShotSection* ShotSection =
		Cast<UMovieSceneCinematicShotSection>(ShotTrack->GetAllSections()[0]);
	return SubSection != nullptr
		&& SubSection->GetSequence() == Sequence
		&& SubSection->GetRange()
			== TRange<FFrameNumber>(FFrameNumber(0), FFrameNumber(60000))
		&& ShotSection != nullptr
		&& ShotSection->GetSequence() == Sequence
		&& ShotSection->GetRange()
			== TRange<FFrameNumber>(FFrameNumber(60000), FFrameNumber(120000))
		&& ShotSection->GetShotDisplayName() == TEXT("Text timeline reprise");
}

bool GenerateTable(const FFixtureTableDefinition& Definition)
{
	FString Json;
	if (Definition.SourcePath != nullptr)
	{
		const FString SourceFilename = FPaths::ConvertRelativePathToFull(
			FPaths::ProjectDir(), Definition.SourcePath);
		if (!FFileHelper::LoadFileToString(Json, *SourceFilename))
		{
			UE_LOG(LogTemp, Error, TEXT("Could not read fixture source %s"), *SourceFilename);
			return false;
		}
	}

	UPackage* Package = FindOrCreatePackage(Definition.PackageName);
	if (Package == nullptr)
	{
		UE_LOG(LogTemp, Error, TEXT("Could not create package %s"), Definition.PackageName);
		return false;
	}

	UDataTable* Table = FindObject<UDataTable>(Package, Definition.AssetName);
	const bool WasCreated = Table == nullptr;
	if (WasCreated)
	{
		Table = NewObject<UDataTable>(
			Package, Definition.AssetName, RF_Public | RF_Standalone | RF_Transactional);
	}

	if (!WasCreated)
	{
		if (Table->RowStruct == nullptr)
		{
			Table->RowStruct = Definition.RowStruct;
		}
		Table->EmptyTable();
	}
	Table->RowStruct = Definition.RowStruct;
	TArray<FString> Problems;
	if (Definition.GeneratedRowCount > 0)
	{
		for (int32 Index = 0; Index < Definition.GeneratedRowCount; ++Index)
		{
			FUEShedFixtureScalarsRow Row;
			Row.Enabled = Index % 2 == 0;
			Row.Count = Index % 101;
			Row.Ratio = static_cast<float>(Index % 101) / 100.0f;
			Row.Key = FName(*FString::Printf(TEXT("LoadKey_%05d"), Index));
			Row.Notes = FString::Printf(TEXT("Deterministic load fixture row %05d."), Index);
			Table->AddRow(FName(*FString::Printf(TEXT("Load_%05d"), Index)), Row);
		}
	}
	else
	{
		Problems = Table->CreateTableFromJSONString(Json);
	}
	for (const FString& Problem : Problems)
	{
		UE_LOG(LogTemp, Error, TEXT("%s: %s"), Definition.AssetName, *Problem);
	}
	if (!Problems.IsEmpty())
	{
		return false;
	}

	if (WasCreated)
	{
		FAssetRegistryModule::AssetCreated(Table);
	}
	Package->MarkPackageDirty();
	if (!SaveAsset(Package, Table))
	{
		UE_LOG(LogTemp, Error, TEXT("Could not save %s"), Definition.PackageName);
		return false;
	}

	UE_LOG(LogTemp, Display, TEXT("Generated %s with %d rows"),
		*ObjectPath(Definition), Table->GetRowMap().Num());
	return true;
}

bool GenerateComposite()
{
	static const TCHAR* PackageName = TEXT("/Game/Fixture/Authoring/CDT_Scalars");
	static const TCHAR* AssetName = TEXT("CDT_Scalars");

	UDataTable* Base = LoadObject<UDataTable>(
		nullptr, TEXT("/Game/Fixture/Authoring/DT_Scalars.DT_Scalars"));
	UDataTable* Override = LoadObject<UDataTable>(
		nullptr, TEXT("/Game/Fixture/Authoring/DT_ScalarsOverride.DT_ScalarsOverride"));
	if (Base == nullptr || Override == nullptr)
	{
		UE_LOG(LogTemp, Error, TEXT("Could not load composite parent tables"));
		return false;
	}

	UPackage* Package = FindOrCreatePackage(PackageName);
	if (Package == nullptr)
	{
		return false;
	}

	UCompositeDataTable* Composite = FindObject<UCompositeDataTable>(Package, AssetName);
	const bool WasCreated = Composite == nullptr;
	if (WasCreated)
	{
		Composite = NewObject<UCompositeDataTable>(
			Package, AssetName, RF_Public | RF_Standalone | RF_Transactional);
	}

	if (!WasCreated)
	{
		if (Composite->RowStruct == nullptr)
		{
			Composite->RowStruct = FUEShedFixtureScalarsRow::StaticStruct();
		}
		Composite->EmptyTable();
	}
	Composite->RowStruct = FUEShedFixtureScalarsRow::StaticStruct();
	Composite->AppendParentTables({ Base, Override });
	if (WasCreated)
	{
		FAssetRegistryModule::AssetCreated(Composite);
	}
	Package->MarkPackageDirty();
	if (!SaveAsset(Package, Composite))
	{
		UE_LOG(LogTemp, Error, TEXT("Could not save %s"), PackageName);
		return false;
	}

	UE_LOG(LogTemp, Display, TEXT("Generated %s.%s with %d composed rows"),
		PackageName, AssetName, Composite->GetRowMap().Num());
	return true;
}

bool VerifyTable(const FFixtureTableDefinition& Definition)
{
	UDataTable* Table = LoadObject<UDataTable>(nullptr, *ObjectPath(Definition));
	if (Table == nullptr)
	{
		UE_LOG(LogTemp, Error, TEXT("Missing fixture table %s"), *ObjectPath(Definition));
		return false;
	}
	if (Table->GetRowStruct() != Definition.RowStruct)
	{
		UE_LOG(LogTemp, Error, TEXT("Unexpected row struct for %s: %s"),
			*ObjectPath(Definition), *GetNameSafe(Table->GetRowStruct()));
		return false;
	}
	if (Table->GetRowMap().IsEmpty())
	{
		UE_LOG(LogTemp, Error, TEXT("Fixture table %s has no rows"), *ObjectPath(Definition));
		return false;
	}

	if (Definition.GeneratedRowCount > 0)
	{
		const TArray<FName> RowNames = Table->GetRowNames();
		const FName FirstRowName(TEXT("Load_00000"));
		const FName LastRowName(*FString::Printf(
			TEXT("Load_%05d"), Definition.GeneratedRowCount - 1));
		const FName LastRowKey(*FString::Printf(
			TEXT("LoadKey_%05d"), Definition.GeneratedRowCount - 1));
		const FUEShedFixtureScalarsRow* FirstRow = Table->FindRow<FUEShedFixtureScalarsRow>(
			FirstRowName, TEXT("fixture verification"), false);
		const FUEShedFixtureScalarsRow* LastRow = Table->FindRow<FUEShedFixtureScalarsRow>(
			LastRowName, TEXT("fixture verification"), false);
		const bool bMatches = RowNames.Num() == Definition.GeneratedRowCount
			&& RowNames[0] == FirstRowName
			&& RowNames.Last() == LastRowName
			&& FirstRow != nullptr && FirstRow->Enabled && FirstRow->Count == 0
			&& LastRow != nullptr && !LastRow->Enabled
			&& LastRow->Key == LastRowKey;
		if (!bMatches)
		{
			UE_LOG(LogTemp, Error, TEXT("Generated load table does not match: %s"),
				*ObjectPath(Definition));
		}
		return bMatches;
	}

	const FString SourceFilename = FPaths::ConvertRelativePathToFull(
		FPaths::ProjectDir(), Definition.SourcePath);
	FString Json;
	if (!FFileHelper::LoadFileToString(Json, *SourceFilename))
	{
		return false;
	}
	TArray<TSharedPtr<FJsonValue>> SourceRows;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Json);
	if (!FJsonSerializer::Deserialize(Reader, SourceRows))
	{
		UE_LOG(LogTemp, Error, TEXT("Could not parse fixture source %s"), *SourceFilename);
		return false;
	}

	TArray<FName> ExpectedRowNames;
	for (const TSharedPtr<FJsonValue>& SourceRow : SourceRows)
	{
		const TSharedPtr<FJsonObject> RowObject = SourceRow->AsObject();
		FString RowName;
		if (!RowObject.IsValid() || !RowObject->TryGetStringField(TEXT("Name"), RowName))
		{
			return false;
		}
		ExpectedRowNames.Add(FName(RowName));
	}

	const TArray<FName> ActualRowNames = Table->GetRowNames();
	if (ActualRowNames != ExpectedRowNames)
	{
		UE_LOG(LogTemp, Error, TEXT("Unexpected row order for %s"), *ObjectPath(Definition));
		return false;
	}
	return true;
}

bool VerifyComposite()
{
	UCompositeDataTable* Composite = LoadObject<UCompositeDataTable>(
		nullptr, TEXT("/Game/Fixture/Authoring/CDT_Scalars.CDT_Scalars"));
	if (Composite == nullptr || Composite->GetRowStruct() != FUEShedFixtureScalarsRow::StaticStruct())
	{
		UE_LOG(LogTemp, Error, TEXT("Composite fixture table is missing or has the wrong row struct"));
		return false;
	}

	const TArray<FName> ExpectedRows = {
		TEXT("Scalar_Alpha"), TEXT("Scalar_Beta"), TEXT("Scalar_Gamma")
	};
	for (const FName RowName : ExpectedRows)
	{
		if (!Composite->GetRowMap().Contains(RowName))
		{
			UE_LOG(LogTemp, Error, TEXT("Composite fixture table is missing row %s"), *RowName.ToString());
			return false;
		}
	}
	return Composite->GetRowMap().Num() == ExpectedRows.Num();
}

bool GenerateGameTextCorpus()
{
	static const TCHAR* StringTablePackageName = TEXT("/Game/Fixture/Text/ST_Game");
	static const TCHAR* StringTableAssetName = TEXT("ST_Game");
	UPackage* StringTablePackage = FindOrCreatePackage(StringTablePackageName);
	if (StringTablePackage == nullptr) return false;
	UStringTable* StringTable = FindObject<UStringTable>(StringTablePackage, StringTableAssetName);
	const bool bStringTableCreated = StringTable == nullptr;
	if (bStringTableCreated)
	{
		StringTable = NewObject<UStringTable>(StringTablePackage, StringTableAssetName,
			RF_Public | RF_Standalone | RF_Transactional);
	}
	FStringTableRef MutableTable = StringTable->GetMutableStringTable();
	MutableTable->ClearSourceStrings();
	MutableTable->SetNamespace(FTextKey(TEXT("Fixture.StringTable")));
	MutableTable->SetSourceString(FTextKey(TEXT("PromptContinue")), TEXT("Continue"));
	MutableTable->SetSourceString(FTextKey(TEXT("StatusSaving")), TEXT("Saving progress…"));
	MutableTable->SetSourceString(FTextKey(TEXT("PromptHold")), TEXT("Hold to skip"));
	if (bStringTableCreated) FAssetRegistryModule::AssetCreated(StringTable);
	StringTablePackage->MarkPackageDirty();
	if (!SaveAsset(StringTablePackage, StringTable)) return false;

	static const TCHAR* TextAssetPackageName = TEXT("/Game/Fixture/Text/DA_TextOccurrences");
	static const TCHAR* TextAssetName = TEXT("DA_TextOccurrences");
	UPackage* TextAssetPackage = FindOrCreatePackage(TextAssetPackageName);
	if (TextAssetPackage == nullptr) return false;
	UUEShedFixtureTextAsset* TextAsset =
		FindObject<UUEShedFixtureTextAsset>(TextAssetPackage, TextAssetName);
	const bool bTextAssetCreated = TextAsset == nullptr;
	if (bTextAssetCreated)
	{
		TextAsset = NewObject<UUEShedFixtureTextAsset>(TextAssetPackage, TextAssetName,
			RF_Public | RF_Standalone | RF_Transactional);
	}
	const FText Shared = FText::ChangeKey(FTextKey(TEXT("Fixture.Shared")),
		FTextKey(TEXT("SharedHoldPrompt")), FText::FromString(TEXT("Hold to skip")));
	TextAsset->SharedPrimary = Shared;
	TextAsset->SharedSecondary = Shared;
	TextAsset->EqualSourceFirst = FText::ChangeKey(FTextKey(TEXT("Fixture.Context")),
		FTextKey(TEXT("ConfirmAction")), FText::FromString(TEXT("Confirm")));
	TextAsset->EqualSourceSecond = FText::ChangeKey(FTextKey(TEXT("Fixture.Context")),
		FTextKey(TEXT("ConfirmDeletion")), FText::FromString(TEXT("Confirm")));
	TextAsset->StringTableReference = FText::FromStringTable(
		StringTable->GetStringTableId(), FTextKey(TEXT("PromptContinue")));
	if (bTextAssetCreated) FAssetRegistryModule::AssetCreated(TextAsset);
	TextAssetPackage->MarkPackageDirty();
	return SaveAsset(TextAssetPackage, TextAsset);
}

bool VerifyGameTextCorpus()
{
	const UStringTable* StringTable = LoadObject<UStringTable>(
		nullptr, TEXT("/Game/Fixture/Text/ST_Game.ST_Game"));
	if (StringTable == nullptr || StringTable->GetStringTable()->GetNamespace()
		!= TEXT("Fixture.StringTable")) return false;
	FString ContinueSource;
	if (!StringTable->GetStringTable()->GetSourceString(
		FTextKey(TEXT("PromptContinue")), ContinueSource)
		|| ContinueSource != TEXT("Continue")) return false;

	const UUEShedFixtureTextAsset* TextAsset = LoadObject<UUEShedFixtureTextAsset>(
		nullptr, TEXT("/Game/Fixture/Text/DA_TextOccurrences.DA_TextOccurrences"));
	if (TextAsset == nullptr) return false;
	const TOptional<FString> SharedNamespace = FTextInspector::GetNamespace(TextAsset->SharedPrimary);
	const TOptional<FString> SharedKey = FTextInspector::GetKey(TextAsset->SharedPrimary);
	return SharedNamespace == FString(TEXT("Fixture.Shared"))
		&& SharedKey == FString(TEXT("SharedHoldPrompt"))
		&& FTextInspector::GetNamespace(TextAsset->SharedSecondary) == SharedNamespace
		&& FTextInspector::GetKey(TextAsset->SharedSecondary) == SharedKey
		&& TextAsset->EqualSourceFirst.ToString() == TEXT("Confirm")
		&& TextAsset->EqualSourceSecond.ToString() == TEXT("Confirm")
		&& FTextInspector::GetKey(TextAsset->EqualSourceFirst)
			!= FTextInspector::GetKey(TextAsset->EqualSourceSecond)
		&& TextAsset->StringTableReference.IsFromStringTable();
}

TSharedRef<FJsonObject> TextEvidence(const FText& Text)
{
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("kind"), TEXT("text"));
	Result->SetStringField(TEXT("displayString"), Text.ToString());
	if (const FString* Source = FTextInspector::GetSourceString(Text))
	{
		Result->SetStringField(TEXT("sourceString"), *Source);
	}

	FName TableId;
	FString TableKey;
	const TSharedRef<FJsonObject> Identity = MakeShared<FJsonObject>();
	if (FTextInspector::GetTableIdAndKey(Text, TableId, TableKey))
	{
		Identity->SetStringField(TEXT("kind"), TEXT("string_table"));
		Identity->SetStringField(TEXT("tableId"), TableId.ToString());
		Identity->SetStringField(TEXT("key"), TableKey);
	}
	else
	{
		Identity->SetStringField(TEXT("kind"), TEXT("localized"));
		Identity->SetStringField(TEXT("namespace"),
			FTextInspector::GetNamespace(Text).Get(FString()));
		Identity->SetStringField(TEXT("key"), FTextInspector::GetKey(Text).Get(FString()));
	}
	Result->SetObjectField(TEXT("identity"), Identity);
	return Result;
}

bool WriteStringTableEvidence(const FString& OutputDirectory)
{
	const UStringTable* StringTable = LoadObject<UStringTable>(
		nullptr, TEXT("/Game/Fixture/Text/ST_Game.ST_Game"));
	if (StringTable == nullptr) return false;

	TArray<TPair<FString, FString>> SourceStrings;
	StringTable->GetStringTable()->EnumerateSourceStrings(
		[&SourceStrings](const FString& Key, const FString& Source)
		{
			SourceStrings.Emplace(Key, Source);
			return true;
		});
	SourceStrings.Sort([](const TPair<FString, FString>& Left,
		const TPair<FString, FString>& Right) { return Left.Key < Right.Key; });

	const TSharedRef<FJsonObject> Root = EvidenceRoot(TEXT("string_table"), StringTable);
	Root->SetStringField(TEXT("namespace"), StringTable->GetStringTable()->GetNamespace());
	TArray<TSharedPtr<FJsonValue>> Entries;
	for (const TPair<FString, FString>& SourceString : SourceStrings)
	{
		const TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
		Entry->SetStringField(TEXT("key"), SourceString.Key);
		Entry->SetStringField(TEXT("source"), SourceString.Value);
		Entries.Add(MakeShared<FJsonValueObject>(Entry));
	}
	Root->SetArrayField(TEXT("entries"), Entries);
	return WriteJsonEvidence(
		FPaths::Combine(OutputDirectory, TEXT("parser-targets/string-table.json")), Root);
}

bool WriteTextAssetEvidence(const FString& OutputDirectory)
{
	const UUEShedFixtureTextAsset* TextAsset = LoadObject<UUEShedFixtureTextAsset>(
		nullptr, TEXT("/Game/Fixture/Text/DA_TextOccurrences.DA_TextOccurrences"));
	if (TextAsset == nullptr) return false;

	const TSharedRef<FJsonObject> Root = EvidenceRoot(TEXT("text_data_asset"), TextAsset);
	TArray<TSharedPtr<FJsonValue>> Properties;
	const TArray<TPair<FString, const FText*>> Values = {
		{ TEXT("SharedPrimary"), &TextAsset->SharedPrimary },
		{ TEXT("SharedSecondary"), &TextAsset->SharedSecondary },
		{ TEXT("EqualSourceFirst"), &TextAsset->EqualSourceFirst },
		{ TEXT("EqualSourceSecond"), &TextAsset->EqualSourceSecond },
		{ TEXT("StringTableReference"), &TextAsset->StringTableReference }
	};
	for (const TPair<FString, const FText*>& Value : Values)
	{
		const TSharedRef<FJsonObject> Property = MakeShared<FJsonObject>();
		Property->SetStringField(TEXT("name"), Value.Key);
		Property->SetStringField(TEXT("typeName"), TEXT("TextProperty"));
		Property->SetObjectField(TEXT("value"), TextEvidence(*Value.Value));
		Properties.Add(MakeShared<FJsonValueObject>(Property));
	}
	Root->SetArrayField(TEXT("properties"), Properties);
	return WriteJsonEvidence(
		FPaths::Combine(OutputDirectory, TEXT("parser-targets/text-data-asset.json")), Root);
}

bool WriteLevelSequenceEvidence(const FString& OutputDirectory)
{
	const ULevelSequence* Sequence = LoadObject<ULevelSequence>(
		nullptr, TEXT("/Game/Fixture/Sequences/LS_TextTimeline.LS_TextTimeline"));
	if (Sequence == nullptr || Sequence->GetMovieScene() == nullptr) return false;
	UMovieScene* MovieScene = Sequence->GetMovieScene();
	const TSharedRef<FJsonObject> Root = EvidenceRoot(TEXT("level_sequence"), Sequence);

	const TSharedRef<FJsonObject> Timeline = MakeShared<FJsonObject>();
	const TSharedRef<FJsonObject> TickResolution = MakeShared<FJsonObject>();
	TickResolution->SetNumberField(TEXT("numerator"), MovieScene->GetTickResolution().Numerator);
	TickResolution->SetNumberField(TEXT("denominator"), MovieScene->GetTickResolution().Denominator);
	Timeline->SetObjectField(TEXT("tickResolution"), TickResolution);
	const TSharedRef<FJsonObject> DisplayRate = MakeShared<FJsonObject>();
	DisplayRate->SetNumberField(TEXT("numerator"), MovieScene->GetDisplayRate().Numerator);
	DisplayRate->SetNumberField(TEXT("denominator"), MovieScene->GetDisplayRate().Denominator);
	Timeline->SetObjectField(TEXT("displayRate"), DisplayRate);
	Timeline->SetNumberField(TEXT("playbackStart"),
		MovieScene->GetPlaybackRange().GetLowerBoundValue().Value);
	Timeline->SetNumberField(TEXT("playbackEnd"),
		MovieScene->GetPlaybackRange().GetUpperBoundValue().Value);
	Root->SetObjectField(TEXT("timeline"), Timeline);

	TArray<TSharedPtr<FJsonValue>> Bindings;
	const TArray<FMovieSceneBinding>& SceneBindings =
		static_cast<const UMovieScene*>(MovieScene)->GetBindings();
	for (const FMovieSceneBinding& Binding : SceneBindings)
	{
		const TSharedRef<FJsonObject> BindingJson = MakeShared<FJsonObject>();
		const FMovieScenePossessable* Possessable = MovieScene->FindPossessable(Binding.GetObjectGuid());
		if (Possessable != nullptr)
		{
			BindingJson->SetStringField(TEXT("name"), Possessable->GetName());
			if (const UClass* ObjectClass = Possessable->GetPossessedObjectClass())
			{
				BindingJson->SetStringField(TEXT("possessedObjectClass"), ObjectClass->GetPathName());
			}
		}
		TArray<TSharedPtr<FJsonValue>> Tracks;
		for (const UMovieSceneTrack* BaseTrack : Binding.GetTracks())
		{
			const UMovieSceneTextTrack* Track = Cast<UMovieSceneTextTrack>(BaseTrack);
			if (Track == nullptr) continue;
			const TSharedRef<FJsonObject> TrackJson = MakeShared<FJsonObject>();
			TrackJson->SetStringField(TEXT("objectPath"), Track->GetPathName());
			TrackJson->SetStringField(TEXT("classPath"), Track->GetClass()->GetPathName());
			TrackJson->SetStringField(TEXT("propertyPath"), Track->GetPropertyPath().ToString());
			TArray<TSharedPtr<FJsonValue>> Sections;
			for (const UMovieSceneSection* BaseSection : Track->GetAllSections())
			{
				const UMovieSceneTextSection* Section = Cast<UMovieSceneTextSection>(BaseSection);
				if (Section == nullptr) continue;
				const TSharedRef<FJsonObject> SectionJson = MakeShared<FJsonObject>();
				SectionJson->SetStringField(TEXT("objectPath"), Section->GetPathName());
				SectionJson->SetNumberField(TEXT("start"),
					Section->GetRange().GetLowerBoundValue().Value);
				SectionJson->SetNumberField(TEXT("end"),
					Section->GetRange().GetUpperBoundValue().Value);
				const TMovieSceneChannelData<const FText> ChannelData = Section->GetChannel().GetData();
				const TArrayView<const FFrameNumber> Times = ChannelData.GetTimes();
				const TArrayView<const FText> Values = ChannelData.GetValues();
				TArray<TSharedPtr<FJsonValue>> Keys;
				for (int32 Index = 0; Index < FMath::Min(Times.Num(), Values.Num()); ++Index)
				{
					const TSharedRef<FJsonObject> Key = MakeShared<FJsonObject>();
					Key->SetNumberField(TEXT("frame"), Times[Index].Value);
					Key->SetObjectField(TEXT("text"), TextEvidence(Values[Index]));
					Keys.Add(MakeShared<FJsonValueObject>(Key));
				}
				SectionJson->SetArrayField(TEXT("keys"), Keys);
				Sections.Add(MakeShared<FJsonValueObject>(SectionJson));
			}
			TrackJson->SetArrayField(TEXT("sections"), Sections);
			Tracks.Add(MakeShared<FJsonValueObject>(TrackJson));
		}
		BindingJson->SetArrayField(TEXT("tracks"), Tracks);
		Bindings.Add(MakeShared<FJsonValueObject>(BindingJson));
	}
	Root->SetArrayField(TEXT("bindings"), Bindings);

	const ULevelSequence* NestedSequence = LoadObject<ULevelSequence>(
		nullptr, TEXT("/Game/Fixture/Sequences/LS_NestedTimeline.LS_NestedTimeline"));
	if (NestedSequence == nullptr || NestedSequence->GetMovieScene() == nullptr) return false;
	const TSharedRef<FJsonObject> NestedTimeline = MakeShared<FJsonObject>();
	NestedTimeline->SetStringField(TEXT("objectPath"), NestedSequence->GetPathName());
	NestedTimeline->SetStringField(TEXT("classPath"),
		NestedSequence->GetClass()->GetPathName());
	TArray<TSharedPtr<FJsonValue>> RootTracks;
	for (const UMovieSceneTrack* BaseTrack : NestedSequence->GetMovieScene()->GetTracks())
	{
		const UMovieSceneSubTrack* Track = Cast<UMovieSceneSubTrack>(BaseTrack);
		if (Track == nullptr) continue;
		const TSharedRef<FJsonObject> TrackJson = MakeShared<FJsonObject>();
		TrackJson->SetStringField(TEXT("objectPath"), Track->GetPathName());
		TrackJson->SetStringField(TEXT("classPath"), Track->GetClass()->GetPathName());
		TArray<TSharedPtr<FJsonValue>> Sections;
		for (const UMovieSceneSection* BaseSection : Track->GetAllSections())
		{
			const UMovieSceneSubSection* Section = Cast<UMovieSceneSubSection>(BaseSection);
			if (Section == nullptr || Section->GetSequence() == nullptr) continue;
			const TSharedRef<FJsonObject> SectionJson = MakeShared<FJsonObject>();
			SectionJson->SetStringField(TEXT("objectPath"), Section->GetPathName());
			SectionJson->SetStringField(TEXT("classPath"), Section->GetClass()->GetPathName());
			SectionJson->SetNumberField(TEXT("start"),
				Section->GetRange().GetLowerBoundValue().Value);
			SectionJson->SetNumberField(TEXT("end"),
				Section->GetRange().GetUpperBoundValue().Value);
			SectionJson->SetStringField(TEXT("sequencePath"),
				Section->GetSequence()->GetPathName());
			if (const UMovieSceneCinematicShotSection* ShotSection =
				Cast<UMovieSceneCinematicShotSection>(Section))
			{
				SectionJson->SetStringField(TEXT("shotDisplayName"),
					ShotSection->GetShotDisplayName());
			}
			Sections.Add(MakeShared<FJsonValueObject>(SectionJson));
		}
		TrackJson->SetArrayField(TEXT("sections"), Sections);
		RootTracks.Add(MakeShared<FJsonValueObject>(TrackJson));
	}
	NestedTimeline->SetArrayField(TEXT("rootTracks"), RootTracks);
	Root->SetObjectField(TEXT("nestedTimeline"), NestedTimeline);
	return WriteJsonEvidence(
		FPaths::Combine(OutputDirectory, TEXT("parser-targets/level-sequence.json")), Root);
}

bool WriteTextureEvidence(const FString& OutputDirectory)
{
	TArray<FFixtureTextureDefinition> Definitions;
	if (!LoadTextureDefinitions(Definitions)) return false;
	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetObjectField(TEXT("contract"), EvidenceContract());
	Root->SetStringField(TEXT("assetType"), TEXT("texture2d"));
	TArray<TSharedPtr<FJsonValue>> Assets;
	for (const FFixtureTextureDefinition& Definition : Definitions)
	{
		const UTexture2D* Texture = LoadObject<UTexture2D>(nullptr, *Definition.ObjectPath);
		if (Texture == nullptr) return false;
		const TSharedRef<FJsonObject> Asset = MakeShared<FJsonObject>();
		Asset->SetStringField(TEXT("objectPath"), Texture->GetPathName());
		Asset->SetStringField(TEXT("classPath"), Texture->GetClass()->GetPathName());
		const TSharedRef<FJsonObject> Source = MakeShared<FJsonObject>();
		Source->SetNumberField(TEXT("width"), Texture->Source.GetSizeX());
		Source->SetNumberField(TEXT("height"), Texture->Source.GetSizeY());
		Source->SetNumberField(TEXT("slices"), Texture->Source.GetNumSlices());
		Source->SetNumberField(TEXT("mips"), Texture->Source.GetNumMips());
		Source->SetStringField(TEXT("format"), Texture->Source.GetFormat() == TSF_BGRA8
			? TEXT("TSF_BGRA8") : TEXT("unsupported"));
		Asset->SetObjectField(TEXT("source"), Source);
		Asset->SetStringField(TEXT("textureGroup"), TextureGroupName(Texture->LODGroup));
		Asset->SetStringField(TEXT("compression"),
			TextureCompressionName(Texture->CompressionSettings));
		Asset->SetBoolField(TEXT("sRGB"), Texture->SRGB);
		Asset->SetStringField(TEXT("mipGeneration"), MipGenerationName(Texture->MipGenSettings));
		Assets.Add(MakeShared<FJsonValueObject>(Asset));
	}
	Root->SetArrayField(TEXT("assets"), Assets);
	return WriteJsonEvidence(
		FPaths::Combine(OutputDirectory, TEXT("parser-targets/texture2d.json")), Root);
}

FString InputActionValueTypeName(const EInputActionValueType ValueType)
{
	switch (ValueType)
	{
	case EInputActionValueType::Boolean: return TEXT("EInputActionValueType::Boolean");
	case EInputActionValueType::Axis1D: return TEXT("EInputActionValueType::Axis1D");
	case EInputActionValueType::Axis2D: return TEXT("EInputActionValueType::Axis2D");
	case EInputActionValueType::Axis3D: return TEXT("EInputActionValueType::Axis3D");
	default: return FString::Printf(TEXT("unsupported:%d"), static_cast<int32>(ValueType));
	}
}

// One Enhanced Input action asset to generate.
struct FFixtureInputActionSpec
{
	const TCHAR* AssetName;
	const TCHAR* Description;
	EInputActionValueType ValueType;
	bool bConsumeInput;
};

// One key mapping inside a context. `TriggerClass` and each modifier are instanced subobjects,
// which is how Enhanced Input serializes them and how the parser sees them.
struct FFixtureInputMappingSpec
{
	const TCHAR* ActionName;
	FKey Key;
	UClass* TriggerClass;
	TArray<UClass*> ModifierClasses;
};

struct FFixtureInputContextSpec
{
	const TCHAR* AssetName;
	const TCHAR* Description;
	TArray<FFixtureInputMappingSpec> Mappings;
};

/**
 * The fixture's Enhanced Input surface. It is deliberately the size of a small real project so
 * downstream tools meet overlapping contexts, contested keys, trigger and modifier variety, and
 * keys no diagram will have a slot for.
 */
const TArray<FFixtureInputActionSpec>& FixtureInputActionSpecs()
{
	static const TArray<FFixtureInputActionSpec> Specs = {
		// The two original fixture actions keep their names, descriptions, and value types so
		// existing evidence and downstream expectations stay true.
		{ TEXT("IA_Jump"), TEXT("Fixture jump action"), EInputActionValueType::Boolean, false },
		{ TEXT("IA_Move"), TEXT("Fixture move action"), EInputActionValueType::Axis2D, true },
		{ TEXT("IA_Look"), TEXT("Look around"), EInputActionValueType::Axis2D, false },
		{ TEXT("IA_Sprint"), TEXT("Sprint"), EInputActionValueType::Boolean, false },
		{ TEXT("IA_Crouch"), TEXT("Crouch"), EInputActionValueType::Boolean, false },
		{ TEXT("IA_Interact"), TEXT("Interact"), EInputActionValueType::Boolean, true },
		{ TEXT("IA_Fire"), TEXT("Fire weapon"), EInputActionValueType::Boolean, true },
		{ TEXT("IA_Aim"), TEXT("Aim down sights"), EInputActionValueType::Boolean, false },
		{ TEXT("IA_Reload"), TEXT("Reload"), EInputActionValueType::Boolean, false },
		{ TEXT("IA_Melee"), TEXT("Melee attack"), EInputActionValueType::Boolean, false },
		{ TEXT("IA_CycleWeapon"), TEXT("Cycle weapon"), EInputActionValueType::Axis1D, false },
		{ TEXT("IA_Throttle"), TEXT("Vehicle throttle"), EInputActionValueType::Axis1D, false },
		{ TEXT("IA_Steer"), TEXT("Vehicle steering"), EInputActionValueType::Axis2D, false },
		{ TEXT("IA_Handbrake"), TEXT("Handbrake"), EInputActionValueType::Boolean, false },
		{ TEXT("IA_ExitVehicle"), TEXT("Exit vehicle"), EInputActionValueType::Boolean, true },
		{ TEXT("IA_Confirm"), TEXT("Confirm selection"), EInputActionValueType::Boolean, true },
		{ TEXT("IA_Back"), TEXT("Back"), EInputActionValueType::Boolean, true },
		{ TEXT("IA_NavigateMenu"), TEXT("Navigate menu"), EInputActionValueType::Axis2D, false },
		{ TEXT("IA_PhotoToggle"), TEXT("Toggle photo mode"), EInputActionValueType::Boolean, false },
		{ TEXT("IA_PhotoCapture"), TEXT("Capture photo"), EInputActionValueType::Boolean, false }
	};
	return Specs;
}

const TArray<FFixtureInputContextSpec>& FixtureInputContextSpecs()
{
	static const TArray<FFixtureInputContextSpec> Specs = {
		// The original single-context fixture, unchanged: two mappings, one negate modifier.
		{
			TEXT("IMC_Fixture"), TEXT("Fixture mapping context"),
			{
				{ TEXT("IA_Jump"), EKeys::SpaceBar, nullptr, {} },
				{ TEXT("IA_Move"), EKeys::A, nullptr, { UInputModifierNegate::StaticClass() } }
			}
		},
		{
			TEXT("IMC_Gameplay"), TEXT("On-foot gameplay"),
			{
				{ TEXT("IA_Move"), EKeys::W, nullptr, {} },
				{ TEXT("IA_Move"), EKeys::S, nullptr, { UInputModifierNegate::StaticClass() } },
				{ TEXT("IA_Move"), EKeys::A, nullptr,
					{ UInputModifierSwizzleAxis::StaticClass(), UInputModifierNegate::StaticClass() } },
				{ TEXT("IA_Move"), EKeys::D, nullptr,
					{ UInputModifierSwizzleAxis::StaticClass() } },
				{ TEXT("IA_Move"), EKeys::Gamepad_Left2D, nullptr,
					{ UInputModifierDeadZone::StaticClass() } },
				{ TEXT("IA_Look"), EKeys::Mouse2D, nullptr, {} },
				{ TEXT("IA_Look"), EKeys::Gamepad_Right2D, nullptr,
					{ UInputModifierDeadZone::StaticClass() } },
				{ TEXT("IA_Jump"), EKeys::SpaceBar, UInputTriggerPressed::StaticClass(), {} },
				{ TEXT("IA_Jump"), EKeys::Gamepad_FaceButton_Bottom,
					UInputTriggerPressed::StaticClass(), {} },
				{ TEXT("IA_Sprint"), EKeys::LeftShift, UInputTriggerHold::StaticClass(), {} },
				{ TEXT("IA_Sprint"), EKeys::Gamepad_LeftShoulder,
					UInputTriggerHold::StaticClass(), {} },
				{ TEXT("IA_Crouch"), EKeys::LeftControl, UInputTriggerDown::StaticClass(), {} },
				{ TEXT("IA_Crouch"), EKeys::Gamepad_RightThumbstick,
					UInputTriggerPressed::StaticClass(), {} },
				{ TEXT("IA_Interact"), EKeys::E, UInputTriggerPressed::StaticClass(), {} },
				{ TEXT("IA_Interact"), EKeys::Gamepad_FaceButton_Right,
					UInputTriggerPressed::StaticClass(), {} },
				{ TEXT("IA_Fire"), EKeys::LeftMouseButton, nullptr, {} },
				{ TEXT("IA_Fire"), EKeys::Gamepad_RightTrigger, nullptr, {} },
				{ TEXT("IA_Aim"), EKeys::RightMouseButton, UInputTriggerHold::StaticClass(), {} },
				{ TEXT("IA_Aim"), EKeys::Gamepad_LeftTrigger, UInputTriggerHold::StaticClass(), {} },
				{ TEXT("IA_Reload"), EKeys::R, UInputTriggerTap::StaticClass(), {} },
				{ TEXT("IA_Reload"), EKeys::Gamepad_FaceButton_Left,
					UInputTriggerTap::StaticClass(), {} },
				{ TEXT("IA_Melee"), EKeys::F, nullptr, {} },
				{ TEXT("IA_Melee"), EKeys::Gamepad_FaceButton_Top, nullptr, {} },
				{ TEXT("IA_CycleWeapon"), EKeys::MouseWheelAxis, nullptr, {} },
				{ TEXT("IA_CycleWeapon"), EKeys::Gamepad_DPad_Up, nullptr, {} },
				{ TEXT("IA_PhotoToggle"), EKeys::P, UInputTriggerPressed::StaticClass(), {} }
			}
		},
		{
			// Overlays gameplay while driving; it contests W, S, A, D, Space, E and both triggers.
			TEXT("IMC_Vehicle"), TEXT("Vehicle controls"),
			{
				{ TEXT("IA_Throttle"), EKeys::W, nullptr, {} },
				{ TEXT("IA_Throttle"), EKeys::S, nullptr, { UInputModifierNegate::StaticClass() } },
				{ TEXT("IA_Throttle"), EKeys::Gamepad_RightTrigger, nullptr, {} },
				{ TEXT("IA_Throttle"), EKeys::Gamepad_LeftTrigger, nullptr,
					{ UInputModifierNegate::StaticClass() } },
				{ TEXT("IA_Steer"), EKeys::A, nullptr,
					{ UInputModifierSwizzleAxis::StaticClass(), UInputModifierNegate::StaticClass() } },
				{ TEXT("IA_Steer"), EKeys::D, nullptr,
					{ UInputModifierSwizzleAxis::StaticClass() } },
				{ TEXT("IA_Steer"), EKeys::Gamepad_Left2D, nullptr,
					{ UInputModifierDeadZone::StaticClass() } },
				{ TEXT("IA_Handbrake"), EKeys::SpaceBar, UInputTriggerHold::StaticClass(), {} },
				{ TEXT("IA_Handbrake"), EKeys::Gamepad_FaceButton_Bottom,
					UInputTriggerHold::StaticClass(), {} },
				{ TEXT("IA_ExitVehicle"), EKeys::E, UInputTriggerHold::StaticClass(), {} },
				{ TEXT("IA_ExitVehicle"), EKeys::Gamepad_FaceButton_Right,
					UInputTriggerHold::StaticClass(), {} },
				{ TEXT("IA_Look"), EKeys::Mouse2D, nullptr, {} }
			}
		},
		{
			// The menu sits above everything, so its keys are contested by design.
			TEXT("IMC_Menu"), TEXT("Menu navigation"),
			{
				{ TEXT("IA_Confirm"), EKeys::Enter, UInputTriggerPressed::StaticClass(), {} },
				{ TEXT("IA_Confirm"), EKeys::E, UInputTriggerPressed::StaticClass(), {} },
				{ TEXT("IA_Confirm"), EKeys::Gamepad_FaceButton_Bottom,
					UInputTriggerPressed::StaticClass(), {} },
				{ TEXT("IA_Back"), EKeys::Escape, UInputTriggerPressed::StaticClass(), {} },
				{ TEXT("IA_Back"), EKeys::Gamepad_FaceButton_Right,
					UInputTriggerPressed::StaticClass(), {} },
				{ TEXT("IA_NavigateMenu"), EKeys::Up, nullptr, {} },
				{ TEXT("IA_NavigateMenu"), EKeys::Down, nullptr,
					{ UInputModifierNegate::StaticClass() } },
				{ TEXT("IA_NavigateMenu"), EKeys::Gamepad_Left2D, nullptr,
					{ UInputModifierDeadZone::StaticClass() } },
				{ TEXT("IA_CycleWeapon"), EKeys::Tab, UInputTriggerPressed::StaticClass(), {} }
			}
		},
		{
			TEXT("IMC_PhotoMode"), TEXT("Photo mode"),
			{
				{ TEXT("IA_Move"), EKeys::W, nullptr, {} },
				{ TEXT("IA_Move"), EKeys::S, nullptr, { UInputModifierNegate::StaticClass() } },
				{ TEXT("IA_Look"), EKeys::Mouse2D, nullptr,
					{ UInputModifierScalar::StaticClass() } },
				{ TEXT("IA_PhotoCapture"), EKeys::LeftMouseButton,
					UInputTriggerPressed::StaticClass(), {} },
				{ TEXT("IA_PhotoCapture"), EKeys::Gamepad_RightTrigger,
					UInputTriggerPressed::StaticClass(), {} },
				{ TEXT("IA_PhotoToggle"), EKeys::P, UInputTriggerPressed::StaticClass(), {} },
				{ TEXT("IA_Back"), EKeys::Escape, UInputTriggerPressed::StaticClass(), {} }
			}
		}
	};
	return Specs;
}

FString FixtureInputActionPath(const TCHAR* AssetName)
{
	return FString::Printf(TEXT("/Game/Fixture/Input/%s.%s"), AssetName, AssetName);
}

FString FixtureInputContextPath(const TCHAR* AssetName)
{
	return FixtureInputActionPath(AssetName);
}

UInputAction* FindOrCreateInputAction(const TCHAR* PackageName, const TCHAR* AssetName)
{
	UPackage* Package = FindOrCreatePackage(PackageName);
	if (Package == nullptr) return nullptr;
	UInputAction* Action = FindObject<UInputAction>(Package, AssetName);
	if (Action == nullptr)
	{
		Action = NewObject<UInputAction>(Package, AssetName,
			RF_Public | RF_Standalone | RF_Transactional);
		FAssetRegistryModule::AssetCreated(Action);
	}
	return Action;
}

bool GenerateEnhancedInputFixtures()
{
	TMap<FString, UInputAction*> ActionsByName;
	for (const FFixtureInputActionSpec& Spec : FixtureInputActionSpecs())
	{
		const FString PackageName =
			FString::Printf(TEXT("/Game/Fixture/Input/%s"), Spec.AssetName);
		UInputAction* Action = FindOrCreateInputAction(*PackageName, Spec.AssetName);
		if (Action == nullptr) return false;
		Action->ActionDescription = FText::FromString(Spec.Description);
		Action->ValueType = Spec.ValueType;
		Action->bConsumeInput = Spec.bConsumeInput;
		Action->MarkPackageDirty();
		if (!SaveAsset(Action->GetOutermost(), Action)) return false;
		ActionsByName.Add(Spec.AssetName, Action);
	}

	for (const FFixtureInputContextSpec& ContextSpec : FixtureInputContextSpecs())
	{
		const FString PackageName =
			FString::Printf(TEXT("/Game/Fixture/Input/%s"), ContextSpec.AssetName);
		UPackage* MappingPackage = FindOrCreatePackage(*PackageName);
		if (MappingPackage == nullptr) return false;
		UInputMappingContext* MappingContext =
			FindObject<UInputMappingContext>(MappingPackage, ContextSpec.AssetName);
		const bool bCreated = MappingContext == nullptr;
		if (bCreated)
		{
			MappingContext = NewObject<UInputMappingContext>(MappingPackage,
				ContextSpec.AssetName, RF_Public | RF_Standalone | RF_Transactional);
		}
		MappingContext->ContextDescription = FText::FromString(ContextSpec.Description);
		MappingContext->UnmapAll();

		int32 MappingIndex = 0;
		for (const FFixtureInputMappingSpec& MappingSpec : ContextSpec.Mappings)
		{
			UInputAction* const* Action = ActionsByName.Find(MappingSpec.ActionName);
			if (Action == nullptr || *Action == nullptr) return false;
			FEnhancedActionKeyMapping& Mapping = MappingContext->MapKey(*Action, MappingSpec.Key);
			// Subobjects are named deterministically so regenerating the fixture does not churn
			// object paths in the recorded evidence.
			if (MappingSpec.TriggerClass != nullptr)
			{
				const FString TriggerName = FString::Printf(TEXT("%s_%d"),
					*MappingSpec.TriggerClass->GetName(), MappingIndex);
				UInputTrigger* Trigger = NewObject<UInputTrigger>(MappingContext,
					MappingSpec.TriggerClass, *TriggerName);
				Mapping.Triggers.Add(Trigger);
			}
			int32 ModifierIndex = 0;
			for (UClass* ModifierClass : MappingSpec.ModifierClasses)
			{
				const FString ModifierName = FString::Printf(TEXT("%s_%d_%d"),
					*ModifierClass->GetName(), MappingIndex, ModifierIndex);
				UInputModifier* Modifier = NewObject<UInputModifier>(MappingContext,
					ModifierClass, *ModifierName);
				if (UInputModifierNegate* Negate = Cast<UInputModifierNegate>(Modifier))
				{
					Negate->bX = false;
				}
				Mapping.Modifiers.Add(Modifier);
				++ModifierIndex;
			}
			++MappingIndex;
		}

		if (bCreated) FAssetRegistryModule::AssetCreated(MappingContext);
		MappingPackage->MarkPackageDirty();
		if (!SaveAsset(MappingPackage, MappingContext)) return false;
	}
	return true;
}

bool VerifyEnhancedInputFixtures()
{
	TMap<FString, const UInputAction*> ActionsByName;
	for (const FFixtureInputActionSpec& Spec : FixtureInputActionSpecs())
	{
		const UInputAction* Action = LoadObject<UInputAction>(
			nullptr, *FixtureInputActionPath(Spec.AssetName));
		if (Action == nullptr) return false;
		if (Action->ValueType != Spec.ValueType) return false;
		if (Action->bConsumeInput != Spec.bConsumeInput) return false;
		if (Action->ActionDescription.ToString() != Spec.Description) return false;
		ActionsByName.Add(Spec.AssetName, Action);
	}

	for (const FFixtureInputContextSpec& ContextSpec : FixtureInputContextSpecs())
	{
		const UInputMappingContext* MappingContext = LoadObject<UInputMappingContext>(
			nullptr, *FixtureInputContextPath(ContextSpec.AssetName));
		if (MappingContext == nullptr) return false;
		if (MappingContext->ContextDescription.ToString() != ContextSpec.Description) return false;
		const TArray<FEnhancedActionKeyMapping>& Mappings = MappingContext->GetMappings();
		if (Mappings.Num() != ContextSpec.Mappings.Num()) return false;
		for (int32 Index = 0; Index < Mappings.Num(); ++Index)
		{
			const FFixtureInputMappingSpec& Spec = ContextSpec.Mappings[Index];
			const UInputAction* const* Expected = ActionsByName.Find(Spec.ActionName);
			if (Expected == nullptr) return false;
			if (Mappings[Index].Action != *Expected) return false;
			if (Mappings[Index].Key != Spec.Key) return false;
			const int32 ExpectedTriggers = Spec.TriggerClass != nullptr ? 1 : 0;
			if (Mappings[Index].Triggers.Num() != ExpectedTriggers) return false;
			if (ExpectedTriggers == 1
				&& Mappings[Index].Triggers[0]->GetClass() != Spec.TriggerClass)
			{
				return false;
			}
			if (Mappings[Index].Modifiers.Num() != Spec.ModifierClasses.Num()) return false;
			for (int32 Slot = 0; Slot < Spec.ModifierClasses.Num(); ++Slot)
			{
				if (Mappings[Index].Modifiers[Slot]->GetClass() != Spec.ModifierClasses[Slot])
				{
					return false;
				}
			}
		}
	}
	return true;
}

bool WriteEnhancedInputEvidence(const FString& OutputDirectory)
{
	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetObjectField(TEXT("contract"), EvidenceContract());
	Root->SetStringField(TEXT("assetType"), TEXT("enhanced_input"));

	TArray<TSharedPtr<FJsonValue>> Actions;
	for (const FFixtureInputActionSpec& Spec : FixtureInputActionSpecs())
	{
		const UInputAction* Action = LoadObject<UInputAction>(
			nullptr, *FixtureInputActionPath(Spec.AssetName));
		if (Action == nullptr) return false;
		const TSharedRef<FJsonObject> Asset = MakeShared<FJsonObject>();
		Asset->SetStringField(TEXT("objectPath"), Action->GetPathName());
		Asset->SetStringField(TEXT("classPath"), Action->GetClass()->GetPathName());
		Asset->SetStringField(TEXT("actionDescription"), Action->ActionDescription.ToString());
		Asset->SetStringField(TEXT("valueType"), InputActionValueTypeName(Action->ValueType));
		Asset->SetBoolField(TEXT("consumeInput"), Action->bConsumeInput);
		Actions.Add(MakeShared<FJsonValueObject>(Asset));
	}
	Root->SetArrayField(TEXT("actions"), Actions);

	TArray<TSharedPtr<FJsonValue>> Contexts;
	for (const FFixtureInputContextSpec& ContextSpec : FixtureInputContextSpecs())
	{
		const UInputMappingContext* MappingContext = LoadObject<UInputMappingContext>(
			nullptr, *FixtureInputContextPath(ContextSpec.AssetName));
		if (MappingContext == nullptr) return false;
		const TSharedRef<FJsonObject> Context = MakeShared<FJsonObject>();
		Context->SetStringField(TEXT("objectPath"), MappingContext->GetPathName());
		Context->SetStringField(TEXT("classPath"), MappingContext->GetClass()->GetPathName());
		Context->SetStringField(TEXT("contextDescription"),
			MappingContext->ContextDescription.ToString());
		Context->SetStringField(TEXT("mappingsProperty"), TEXT("DefaultKeyMappings"));
		TArray<TSharedPtr<FJsonValue>> Mappings;
		for (const FEnhancedActionKeyMapping& Mapping : MappingContext->GetMappings())
		{
			const TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
			Entry->SetStringField(TEXT("action"),
				Mapping.Action != nullptr ? Mapping.Action->GetPathName() : FString());
			Entry->SetStringField(TEXT("keyName"), Mapping.Key.GetFName().ToString());
			TArray<TSharedPtr<FJsonValue>> Triggers;
			for (const TObjectPtr<UInputTrigger>& Trigger : Mapping.Triggers)
			{
				if (Trigger == nullptr) continue;
				const TSharedRef<FJsonObject> TriggerObject = MakeShared<FJsonObject>();
				TriggerObject->SetStringField(TEXT("objectPath"), Trigger->GetPathName());
				TriggerObject->SetStringField(TEXT("classPath"),
					Trigger->GetClass()->GetPathName());
				Triggers.Add(MakeShared<FJsonValueObject>(TriggerObject));
			}
			Entry->SetArrayField(TEXT("triggers"), Triggers);
			TArray<TSharedPtr<FJsonValue>> Modifiers;
			for (const TObjectPtr<UInputModifier>& Modifier : Mapping.Modifiers)
			{
				if (Modifier == nullptr) continue;
				const TSharedRef<FJsonObject> ModifierObject = MakeShared<FJsonObject>();
				ModifierObject->SetStringField(TEXT("objectPath"), Modifier->GetPathName());
				ModifierObject->SetStringField(TEXT("classPath"),
					Modifier->GetClass()->GetPathName());
				Modifiers.Add(MakeShared<FJsonValueObject>(ModifierObject));
			}
			Entry->SetArrayField(TEXT("modifiers"), Modifiers);
			Mappings.Add(MakeShared<FJsonValueObject>(Entry));
		}
		Context->SetArrayField(TEXT("mappings"), Mappings);
		Contexts.Add(MakeShared<FJsonValueObject>(Context));
	}
	Root->SetArrayField(TEXT("mappingContexts"), Contexts);

	return WriteJsonEvidence(
		FPaths::Combine(OutputDirectory, TEXT("parser-targets/enhanced-input.json")), Root);
}


bool WriteAuthoringEvidence(const FString& OutputDirectory)
{
	bool bSucceeded = true;
	for (const FFixtureTableDefinition& Definition : GetTableDefinitions())
	{
		FString SnapshotJson;
		UUEShedAuthoringLibrary::GetTableSnapshot(ObjectPath(Definition), SnapshotJson);
		const FString Filename = FPaths::Combine(
			OutputDirectory, TEXT("authoring"), FString(Definition.AssetName) + TEXT(".json"));
		IFileManager::Get().MakeDirectory(*FPaths::GetPath(Filename), true);
		bSucceeded = FFileHelper::SaveStringToFile(SnapshotJson, *Filename,
			FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM) && bSucceeded;
	}
	FString CompositeJson;
	UUEShedAuthoringLibrary::GetTableSnapshot(
		TEXT("/Game/Fixture/Authoring/CDT_Scalars.CDT_Scalars"), CompositeJson);
	const FString CompositeFilename = FPaths::Combine(
		OutputDirectory, TEXT("authoring/CDT_Scalars.json"));
	IFileManager::Get().MakeDirectory(*FPaths::GetPath(CompositeFilename), true);
	return FFileHelper::SaveStringToFile(CompositeJson, *CompositeFilename,
		FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM) && bSucceeded;
}

const TCHAR* LevelEvidenceObjectPath = TEXT("/Game/Fixture/Cameras/L_CameraLoad");

/// Records which top-level property tags Unreal actually writes for one object.
///
/// Inferring this from property flags plus an archetype comparison is not reliable: it still claimed
/// `UMaterialInstanceDynamic::BasePropertyOverrides` was written when the name is not even in the
/// saved package's name table. So this asks the engine instead. Running the real tagged-property
/// serializer and recording the property behind each write is exact by construction, and it stays
/// exact for classes whose behaviour we have not studied.
/// Only the property identity of each write matters, so reference types are recorded and dropped
/// rather than resolved. That also keeps the archive off `FArchiveUObject`, whose object-pointer
/// support this recorder does not need.
class FSerializedTagRecorder : public FMemoryWriter
{
public:
	FSerializedTagRecorder(TArray<uint8>& InBytes, TSet<FName>& OutNames)
		: FMemoryWriter(InBytes, /*bIsPersistent*/ true)
		, Names(OutNames)
	{
	}

	virtual void Serialize(void* Data, int64 Length) override
	{
		Record();
		FMemoryWriter::Serialize(Data, Length);
	}

	virtual FArchive& operator<<(FName& Value) override { Record(); return *this; }
	virtual FArchive& operator<<(UObject*& Value) override { Record(); return *this; }
	virtual FArchive& operator<<(FObjectPtr& Value) override { Record(); return *this; }
	virtual FArchive& operator<<(FLazyObjectPtr& Value) override { Record(); return *this; }
	virtual FArchive& operator<<(FSoftObjectPtr& Value) override { Record(); return *this; }
	virtual FArchive& operator<<(FSoftObjectPath& Value) override { Record(); return *this; }
	virtual FArchive& operator<<(FWeakObjectPtr& Value) override { Record(); return *this; }

private:
	void Record()
	{
		const FArchiveSerializedPropertyChain* Chain = GetSerializedPropertyChain();
		if (Chain != nullptr && Chain->GetNumProperties() > 0)
		{
			// Index 0 is the outermost property, which is the tag written into the stream.
			if (const FProperty* Root = Chain->GetPropertyFromRoot(0))
			{
				Names.Add(Root->GetFName());
			}
			return;
		}
		if (const FProperty* Property = GetSerializedProperty())
		{
			Names.Add(Property->GetFName());
		}
	}

	TSet<FName>& Names;
};

/// Returns the property tags Unreal writes for `Object`, by running its tagged-property serializer.
TSet<FName> SerializedPropertyTags(const UObject* Object)
{
	TSet<FName> Names;
	UClass* Class = Object->GetClass();
	TArray<uint8> Bytes;
	FSerializedTagRecorder Recorder(Bytes, Names);
	FStructuredArchiveFromArchive Adapter(Recorder);
	// Const-cast is safe here: the archive only writes, and the fixture level is loaded read-only.
	Class->SerializeTaggedProperties(Adapter.GetSlot(), reinterpret_cast<uint8*>(
		const_cast<UObject*>(Object)), Class,
		reinterpret_cast<uint8*>(const_cast<UObject*>(Object->GetArchetype())));
	return Names;
}

/// Renders one property value the way the editor exports it to text.
FString LevelPropertyValueText(const FProperty* Property, const void* ValuePtr)
{
	FString Text;
	Property->ExportTextItem_Direct(Text, ValuePtr, nullptr, nullptr, PPF_None);
	return Text;
}

/// Writes the editor-side view of every object saved in the fixture level.
///
/// The parser reads only the tagged property stream, so this evidence deliberately records more
/// than the parser can decode, in two parts. `classes` is the full property view of every class the
/// level instantiates, which is what bounds the parser's possible coverage; it lives per class
/// rather than per export because it is class-level data, and repeating it for all 16k exports cost
/// 194 MB for no extra signal. `exports[].properties` then carries only the properties that differ
/// from the class default object, which is the subset Unreal actually writes into the package and
/// therefore the only subset the parser can be held to. Everything a class declares but an export
/// does not serialize is the documented gap the parser leaves in `tail_bytes`.
bool WriteLevelEvidence(const FString& OutputDirectory)
{
	UPackage* Package = LoadPackage(nullptr, LevelEvidenceObjectPath, LOAD_None);
	if (Package == nullptr) return false;
	Package->FullyLoad();

	TArray<UObject*> Objects;
	GetObjectsWithPackage(Package, Objects, true);
	Objects.Sort([](const UObject& Left, const UObject& Right)
	{
		return Left.GetPathName() < Right.GetPathName();
	});

	// A persistent saving archive, so FProperty::ShouldSerializeValue answers the same question
	// Unreal's package save asks. Hand-rolling that flag matrix gets CPF_SkipSerialization wrong
	// (UModel::Polys) and then blames the parser for a property Unreal never wrote.
	TArray<uint8> ProbeBytes;
	FMemoryWriter SerializeProbe(ProbeBytes, /*bIsPersistent*/ true);

	const TSharedRef<FJsonObject> Classes = MakeShared<FJsonObject>();
	TArray<TSharedPtr<FJsonValue>> Exports;
	for (const UObject* Object : Objects)
	{
		if (Object == nullptr) continue;
		UClass* Class = Object->GetClass();
		const FString ClassPath = Class->GetPathName();
		const bool bClassSeen = Classes->HasField(ClassPath);
		TArray<TSharedPtr<FJsonValue>> Declared;

		const TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
		Entry->SetStringField(TEXT("objectPath"), Object->GetPathName());
		Entry->SetStringField(TEXT("classPath"), ClassPath);

		const TSet<FName> WrittenTags = SerializedPropertyTags(Object);
		TArray<TSharedPtr<FJsonValue>> Serialized;
		for (TFieldIterator<FProperty> It(Class); It; ++It)
		{
			const FProperty* Property = *It;
			if (Property == nullptr || Property->ArrayDim != 1) continue;
			if (!bClassSeen)
			{
				const TSharedRef<FJsonObject> Field = MakeShared<FJsonObject>();
				Field->SetStringField(TEXT("name"), Property->GetName());
				Field->SetStringField(TEXT("type"), Property->GetClass()->GetName());
				Field->SetBoolField(TEXT("serializable"),
					Property->ShouldSerializeValue(SerializeProbe));
				Declared.Add(MakeShared<FJsonValueObject>(Field));
			}
			// Only what the engine's own serializer emitted for this object.
			if (!WrittenTags.Contains(Property->GetFName())) continue;
			const TSharedRef<FJsonObject> Rendered = MakeShared<FJsonObject>();
			Rendered->SetStringField(TEXT("name"), Property->GetName());
			Rendered->SetStringField(TEXT("type"), Property->GetClass()->GetName());
			Rendered->SetStringField(TEXT("value"),
				LevelPropertyValueText(Property, Property->ContainerPtrToValuePtr<void>(Object)));
			Serialized.Add(MakeShared<FJsonValueObject>(Rendered));
		}
		if (!bClassSeen)
		{
			const TSharedRef<FJsonObject> ClassEntry = MakeShared<FJsonObject>();
			ClassEntry->SetArrayField(TEXT("declaredProperties"), Declared);
			Classes->SetObjectField(ClassPath, ClassEntry);
		}
		Entry->SetArrayField(TEXT("properties"), Serialized);
		Exports.Add(MakeShared<FJsonValueObject>(Entry));
	}

	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetObjectField(TEXT("contract"), EvidenceContract());
	Root->SetStringField(TEXT("assetType"), TEXT("level"));
	Root->SetStringField(TEXT("packagePath"), LevelEvidenceObjectPath);
	Root->SetObjectField(TEXT("classes"), Classes);
	Root->SetArrayField(TEXT("exports"), Exports);
	return WriteJsonEvidence(
		FPaths::Combine(OutputDirectory, TEXT("levels/L_CameraLoad.json")), Root);
}

/// Loads the fixture level and walks every serialized property, timing only that work.
///
/// This is the closest editor-side equivalent of one `uasset inspect` over the same package. The
/// commandlet's wall-clock is dominated by editor startup, so the marker line separates the two:
/// `loadSeconds` plus `walkSeconds` is the comparable parse cost, and everything else in the
/// process lifetime is the startup the editor-free parser avoids.
bool BenchmarkLevelParse()
{
	const double LoadStarted = FPlatformTime::Seconds();
	UPackage* Package = LoadPackage(nullptr, LevelEvidenceObjectPath, LOAD_None);
	if (Package == nullptr) return false;
	Package->FullyLoad();
	const double LoadFinished = FPlatformTime::Seconds();

	TArray<uint8> ProbeBytes;
	FMemoryWriter SerializeProbe(ProbeBytes, /*bIsPersistent*/ true);
	TArray<UObject*> Objects;
	GetObjectsWithPackage(Package, Objects, true);
	int32 ObjectCount = 0;
	int64 PropertyCount = 0;
	for (const UObject* Object : Objects)
	{
		if (Object == nullptr) continue;
		++ObjectCount;
		const UObject* Defaults = Object->GetArchetype();
		for (TFieldIterator<FProperty> It(Object->GetClass()); It; ++It)
		{
			const FProperty* Property = *It;
			if (Property == nullptr || Property->ArrayDim != 1) continue;
			// Same save condition the evidence writer uses, so the two lanes walk the same work.
			if (!Property->ShouldSerializeValue(SerializeProbe)) continue;
			if (Defaults != nullptr
				&& Property->Identical_InContainer(Object, Defaults, 0,
					SerializeProbe.GetPortFlags()))
			{
				continue;
			}
			FString Text;
			Property->ExportTextItem_Direct(Text, Property->ContainerPtrToValuePtr<void>(Object),
				nullptr, nullptr, PPF_None);
			++PropertyCount;
		}
	}
	const double WalkFinished = FPlatformTime::Seconds();

	UE_LOG(LogTemp, Display,
		TEXT("UEShedLevelParse objects=%d properties=%lld loadSeconds=%.6f walkSeconds=%.6f"),
		ObjectCount, PropertyCount, LoadFinished - LoadStarted, WalkFinished - LoadFinished);
	return true;
}

bool WriteConformanceEvidence(const FString& OutputDirectory)
{
	return WriteAuthoringEvidence(OutputDirectory)
		&& WriteStringTableEvidence(OutputDirectory)
		&& WriteTextAssetEvidence(OutputDirectory)
		&& WriteLevelSequenceEvidence(OutputDirectory)
		&& WriteTextureEvidence(OutputDirectory)
		&& WriteEnhancedInputEvidence(OutputDirectory)
		&& WriteLevelEvidence(OutputDirectory);
}

void ApplySolidColor(UStaticMeshComponent* Mesh, const FLinearColor& Color)
{
	if (Mesh == nullptr) return;
	UMaterialInterface* Parent = LoadObject<UMaterialInterface>(nullptr,
		TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
	if (Parent == nullptr) return;
	UMaterialInstanceDynamic* Mid = UMaterialInstanceDynamic::Create(Parent, Mesh);
	if (Mid == nullptr) return;
	Mid->SetVectorParameterValue(TEXT("Color"), Color);
	Mesh->SetMaterial(0, Mid);
}

UStaticMeshComponent* AddChildShape(AStaticMeshActor* Owner, const TCHAR* Name,
	const TCHAR* MeshPath, const FVector& RelativeLocation, const FVector& RelativeScale,
	const FLinearColor& Color)
{
	if (Owner == nullptr) return nullptr;
	UStaticMeshComponent* Child = NewObject<UStaticMeshComponent>(Owner, Name);
	Child->SetupAttachment(Owner->GetRootComponent());
	Child->SetMobility(EComponentMobility::Static);
	Child->SetStaticMesh(LoadObject<UStaticMesh>(nullptr, MeshPath));
	Child->SetRelativeLocation(RelativeLocation);
	Child->SetRelativeScale3D(RelativeScale);
	Child->RegisterComponent();
	Owner->AddInstanceComponent(Child);
	ApplySolidColor(Child, Color);
	return Child;
}

const TCHAR* MotionFamilyLabel(const EUEShedFixtureMotion Motion)
{
	switch (Motion)
	{
	case EUEShedFixtureMotion::Flying:
		return TEXT("Flying");
	case EUEShedFixtureMotion::Intermittent:
		return TEXT("Intermittent");
	case EUEShedFixtureMotion::Stationary:
	default:
		return TEXT("Stationary");
	}
}

float MotionBaseHeight(const EUEShedFixtureMotion Motion)
{
	switch (Motion)
	{
	case EUEShedFixtureMotion::Flying:
		return 380.0f;
	case EUEShedFixtureMotion::Intermittent:
		return 160.0f;
	case EUEShedFixtureMotion::Stationary:
	default:
		return 40.0f;
	}
}

bool GenerateOfflineWorldMap()
{
	static const TCHAR* PackageName = TEXT("/Game/Fixture/Offline/L_OfflineWorld");
	static const TCHAR* AssetName = TEXT("L_OfflineWorld");
	static const TCHAR* LegacyPackageName = TEXT("/Game/Fixture/Offline/L_OfflineMap");
	const FString LegacyFilename = FPackageName::LongPackageNameToFilename(
		LegacyPackageName, FPackageName::GetMapPackageExtension());
	if (IFileManager::Get().FileExists(*LegacyFilename)) IFileManager::Get().Delete(*LegacyFilename);
	const FString Filename = FPackageName::LongPackageNameToFilename(
		PackageName, FPackageName::GetMapPackageExtension());
	const FString ExternalActorRoot = FPaths::Combine(FPaths::ProjectContentDir(),
		TEXT("__ExternalActors__/Fixture/Offline/L_OfflineWorld"));
	TArray<FString> ExistingExternalPackages;
	IFileManager::Get().FindFilesRecursive(
		ExistingExternalPackages, *ExternalActorRoot, TEXT("*.uasset"), true, false);
	if (IFileManager::Get().FileExists(*Filename)
		&& ExistingExternalPackages.Num() < OfflineWorldActorCount)
	{
		IFileManager::Get().Delete(*Filename);
	}
	UPackage* Package = FindOrCreatePackage(PackageName);
	if (Package == nullptr) return false;
	UWorld* World = UWorld::FindWorldInPackage(Package);
	const bool bCreatedWorld = World == nullptr;
	if (World == nullptr)
	{
		UWorldFactory* Factory = NewObject<UWorldFactory>();
		Factory->WorldType = EWorldType::Editor;
		Factory->bCreateWorldPartition = true;
		Factory->bEnableWorldPartitionStreaming = false;
		World = Cast<UWorld>(Factory->FactoryCreateNew(UWorld::StaticClass(), Package, AssetName,
			RF_Public | RF_Standalone, nullptr, GWarn));
	}
	if (World == nullptr || !World->IsPartitionedWorld()) return false;
	if (!bCreatedWorld)
	{
		UE_LOG(LogTemp, Display, TEXT("Offline World Partition fixture map already exists"));
		return true;
	}

	auto AddActor = [&](const TCHAR* Label, const FVector& Location,
		const FVector& Scale, const FLinearColor& Color) -> AStaticMeshActor*
	{
		FActorSpawnParameters Spawn;
		Spawn.bCreateActorPackage = true;
		AStaticMeshActor* Actor = World->SpawnActor<AStaticMeshActor>(
			Location, FRotator::ZeroRotator, Spawn);
		if (Actor == nullptr) return nullptr;
		Actor->Tags.Add(TEXT("UEShedOfflineWorld"));
		Actor->SetActorLabel(Label);
		Actor->GetStaticMeshComponent()->SetStaticMesh(LoadObject<UStaticMesh>(nullptr,
			TEXT("/Engine/BasicShapes/Cube.Cube")));
		Actor->SetActorScale3D(Scale);
		ApplySolidColor(Actor->GetStaticMeshComponent(), Color);
		return Actor;
	};

	AStaticMeshActor* Hub = AddActor(TEXT("Offline Hub"),
		FVector(-1200, -450, 120), FVector(4.0, 4.0, 2.0),
		FLinearColor(0.32f, 0.68f, 0.82f, 1.0f));
	AStaticMeshActor* East = AddActor(TEXT("East Marker"),
		FVector(900, -320, 200), FVector(1.3, 1.3, 3.5),
		FLinearColor(0.94f, 0.58f, 0.24f, 1.0f));
	AStaticMeshActor* North = AddActor(TEXT("North Marker"),
		FVector(-220, 1300, 160), FVector(2.6, 1.0, 1.0),
		FLinearColor(0.72f, 0.42f, 0.78f, 1.0f));
	AStaticMeshActor* South = AddActor(TEXT("South Marker"),
		FVector(-500, -1500, 80), FVector(1.0, 3.0, 1.0),
		FLinearColor(0.42f, 0.76f, 0.44f, 1.0f));
	AStaticMeshActor* West = AddActor(TEXT("West Marker"),
		FVector(-2050, 660, 260), FVector(1.8, 1.8, 1.8),
		FLinearColor(0.86f, 0.34f, 0.38f, 1.0f));
	AStaticMeshActor* Attached = AddActor(TEXT("Hub Attachment"),
		FVector::ZeroVector, FVector(0.6, 0.6, 3.0), FLinearColor(0.96f, 0.88f, 0.30f, 1.0f));
	if (Hub == nullptr || East == nullptr || North == nullptr || South == nullptr || West == nullptr
		|| Attached == nullptr) return false;
	Attached->AttachToComponent(Hub->GetRootComponent(), FAttachmentTransformRules::KeepRelativeTransform);
	Attached->SetActorRelativeLocation(FVector(760, 260, 480));

	Package->MarkPackageDirty();
	bool bSaved = SaveAsset(Package, World);
	for (AStaticMeshActor* Actor : { Hub, East, North, South, West, Attached })
	{
		UPackage* ExternalPackage = Actor->GetExternalPackage();
		if (ExternalPackage == nullptr)
		{
			bSaved = false;
			continue;
		}
		ExternalPackage->MarkPackageDirty();
		bSaved = SaveAsset(ExternalPackage, Actor) && bSaved;
	}
	World->CleanupWorld();
	if (!bSaved) return false;
	UE_LOG(LogTemp, Display, TEXT("Generated %s with %d external actors"), PackageName,
		OfflineWorldActorCount);
	return true;
}

constexpr TCHAR MapHistoryPackageName[] = TEXT("/Game/Fixture/History/L_MapHistoryWorld");
constexpr TCHAR MapHistoryAssetName[] = TEXT("L_MapHistoryWorld");
constexpr TCHAR MapHistoryRelativePath[] = TEXT("Content/Fixture/History/L_MapHistoryWorld.umap");
constexpr TCHAR ConventionalMapHistoryPackageName[] =
	TEXT("/Game/Fixture/History/L_ConventionalMapHistory");
constexpr TCHAR ConventionalMapHistoryAssetName[] = TEXT("L_ConventionalMapHistory");
constexpr TCHAR ConventionalMapHistoryRelativePath[] =
	TEXT("Content/Fixture/History/L_ConventionalMapHistory.umap");

FString MapHistoryExternalActorHistoryRoot()
{
	return FPaths::Combine(FPaths::ProjectContentDir(),
		TEXT("__ExternalActors__/Fixture/History"));
}

void DeleteMapHistoryWorkingFiles()
{
	DeletePackageFiles(MapHistoryPackageName, true);
	// This path is reserved for the short-lived source map used only while emitting revision bundles.
	IFileManager::Get().DeleteDirectory(*FPaths::Combine(FPaths::ProjectContentDir(),
		TEXT("Fixture/History")), false, true);
	IFileManager::Get().DeleteDirectory(*MapHistoryExternalActorHistoryRoot(), false, true);
}

bool SaveExternalActor(AStaticMeshActor* Actor)
{
	if (Actor == nullptr || Actor->GetExternalPackage() == nullptr) return false;
	UPackage* Package = Actor->GetExternalPackage();
	Package->MarkPackageDirty();
	return SaveAsset(Package, Actor);
}

FString ExternalActorProjectPath(AStaticMeshActor* Actor)
{
	if (Actor == nullptr || Actor->GetExternalPackage() == nullptr) return FString();
	return ProjectRelativePath(PackageFilename(Actor->GetExternalPackage()->GetName(), false));
}

bool SnapshotMapHistoryRevision(const FString& OutputDirectory, const FString& Revision,
	const FString& MapPackageName, const bool bIncludeMap, const TArray<AStaticMeshActor*>& Actors)
{
	const FString RevisionDirectory = FPaths::Combine(OutputDirectory, TEXT("revisions"), Revision);
	if (IFileManager::Get().DirectoryExists(*RevisionDirectory))
	{
		UE_LOG(LogTemp, Error, TEXT("Map History fixture revision already exists: %s"),
			*RevisionDirectory);
		return false;
	}
	IFileManager::Get().MakeDirectory(*RevisionDirectory, true);
	bool bSucceeded = !bIncludeMap || CopyPackageFiles(MapPackageName, true, RevisionDirectory);
	for (AStaticMeshActor* Actor : Actors)
	{
		if (Actor == nullptr || Actor->GetExternalPackage() == nullptr)
		{
			bSucceeded = false;
			continue;
		}
		bSucceeded = CopyPackageFiles(Actor->GetExternalPackage()->GetName(), false, RevisionDirectory)
			&& bSucceeded;
	}
	return bSucceeded;
}

FString ManifestFileList(const TCHAR* Action, const TArray<FString>& Files)
{
	TArray<FString> Entries;
	Entries.Reserve(Files.Num());
	for (const FString& File : Files)
	{
		Entries.Add(FString::Printf(TEXT("{\"action\":\"%s\",\"path\":\"%s\"}"),
			Action, *File));
	}
	return FString::Join(Entries, TEXT(","));
}

bool WriteMapHistoryScenarioManifest(const FString& OutputDirectory,
	const TArray<FString>& BaselineFiles, const FString& EastFile, const FString& NorthFile,
	const FString& ArrivalFile, const FString& SouthFile, const FString& WestFile)
{
	const FString Baseline = ManifestFileList(TEXT("add"), BaselineFiles);
	const FString East = ManifestFileList(TEXT("edit"), { EastFile });
	const FString North = ManifestFileList(TEXT("edit"), { NorthFile });
	const FString Arrival = ManifestFileList(TEXT("add"), { ArrivalFile });
	const FString South = ManifestFileList(TEXT("delete"), { SouthFile });
	const FString Unclassified = ManifestFileList(TEXT("edit"), { EastFile, WestFile });
	const FString Manifest = FString::Printf(TEXT(R"JSON({
	"schemaVersion": 1,
	"scenario": "world-partition-actor-history",
	"mapPath": "%s",
	"sourceKind": "world_partition",
	"revisions": [
		{"id":"baseline","files":[%s],"expectedChanges":["actor_added"]},
		{"id":"move-east","files":[%s],"expectedChanges":["actor_moved"]},
		{"id":"label-north","files":[%s],"expectedChanges":["actor_label_changed"]},
		{"id":"add-arrival","files":[%s],"expectedChanges":["actor_added"]},
		{"id":"delete-south","files":[%s],"expectedChanges":["actor_removed"]},
		{"id":"two-unclassified-package-edits","files":[%s],"expectedChanges":["unclassified_package_change"]}
	]
})JSON"), MapHistoryRelativePath, *Baseline, *East, *North, *Arrival, *South, *Unclassified);
	return FFileHelper::SaveStringToFile(Manifest,
		*FPaths::Combine(OutputDirectory, TEXT("scenario.json")));
}

bool GenerateConventionalMapHistoryFixture(const FString& OutputDirectory)
{
	UPackage* Package = CreatePackage(ConventionalMapHistoryPackageName);
	if (Package == nullptr) return false;
	UWorldFactory* Factory = NewObject<UWorldFactory>();
	Factory->WorldType = EWorldType::Editor;
	Factory->bCreateWorldPartition = false;
	UWorld* World = Cast<UWorld>(Factory->FactoryCreateNew(UWorld::StaticClass(), Package,
		ConventionalMapHistoryAssetName, RF_Public | RF_Standalone, nullptr, GWarn));
	if (World == nullptr || World->IsPartitionedWorld()) return false;

	FActorSpawnParameters Spawn;
	Spawn.bCreateActorPackage = false;
	AStaticMeshActor* Actor = World->SpawnActor<AStaticMeshActor>(
		FVector(-320, 640, 180), FRotator::ZeroRotator, Spawn);
	if (Actor == nullptr)
	{
		World->CleanupWorld();
		return false;
	}
	Actor->Tags.Add(TEXT("UEShedMapHistoryFixture"));
	Actor->SetActorLabel(TEXT("Conventional Marker"));
	Actor->GetStaticMeshComponent()->SetStaticMesh(LoadObject<UStaticMesh>(nullptr,
		TEXT("/Engine/BasicShapes/Cube.Cube")));
	Actor->SetActorScale3D(FVector(1.5, 1.5, 2.0));
	ApplySolidColor(Actor->GetStaticMeshComponent(), FLinearColor(0.40f, 0.72f, 0.94f, 1.0f));

	Package->MarkPackageDirty();
	bool bSucceeded = SaveAsset(Package, World);
	bSucceeded = SnapshotMapHistoryRevision(OutputDirectory, TEXT("conventional-baseline"),
		ConventionalMapHistoryPackageName, true, {}) && bSucceeded;

	Actor->SetActorLocation(FVector(960, 220, 340));
	Package->MarkPackageDirty();
	bSucceeded = SaveAsset(Package, World) && bSucceeded;
	bSucceeded = SnapshotMapHistoryRevision(OutputDirectory, TEXT("conventional-move-actor"),
		ConventionalMapHistoryPackageName, true, {}) && bSucceeded;

	const FString Baseline = ManifestFileList(TEXT("add"), { ConventionalMapHistoryRelativePath });
	const FString Move = ManifestFileList(TEXT("edit"), { ConventionalMapHistoryRelativePath });
	const FString Manifest = FString::Printf(TEXT(R"JSON({
	"schemaVersion": 1,
	"scenario": "conventional-map-actor-history",
	"mapPath": "%s",
	"sourceKind": "level",
	"revisions": [
		{"id":"conventional-baseline","files":[%s],"expectedChanges":["actor_added"]},
		{"id":"conventional-move-actor","files":[%s],"expectedChanges":["actor_moved"]}
	]
})JSON"), ConventionalMapHistoryRelativePath, *Baseline, *Move);
	bSucceeded = FFileHelper::SaveStringToFile(Manifest,
		*FPaths::Combine(OutputDirectory, TEXT("conventional-scenario.json"))) && bSucceeded;
	World->CleanupWorld();
	return bSucceeded;
}

bool GenerateMapHistoryFixture(const FString& RequestedOutputDirectory, const bool bOverwrite)
{
	const FString OutputDirectory = FPaths::ConvertRelativePathToFull(RequestedOutputDirectory);
	const FString AllowedOutputDirectory = FPaths::ConvertRelativePathToFull(
		FPaths::Combine(FPaths::ProjectDir(), TEXT(".."), TEXT("perforce-map-history")));
	if (!OutputDirectory.Equals(AllowedOutputDirectory, ESearchCase::IgnoreCase))
	{
		UE_LOG(LogTemp, Error, TEXT("Map History fixture output must be %s"),
			*AllowedOutputDirectory);
		return false;
	}
	const FString RevisionsDirectory = FPaths::Combine(OutputDirectory, TEXT("revisions"));
	if (IFileManager::Get().DirectoryExists(*RevisionsDirectory))
	{
		TArray<FString> ExistingFiles;
		IFileManager::Get().FindFilesRecursive(ExistingFiles, *RevisionsDirectory, TEXT("*"), true, false);
		if (!ExistingFiles.IsEmpty() && !bOverwrite)
		{
			UE_LOG(LogTemp, Error, TEXT("Map History fixture revisions already exist: %s"),
				*RevisionsDirectory);
			return false;
		}
		IFileManager::Get().DeleteDirectory(*RevisionsDirectory, false, true);
	}

	DeleteMapHistoryWorkingFiles();
	UPackage* Package = CreatePackage(MapHistoryPackageName);
	if (Package == nullptr) return false;
	UWorldFactory* Factory = NewObject<UWorldFactory>();
	Factory->WorldType = EWorldType::Editor;
	Factory->bCreateWorldPartition = true;
	Factory->bEnableWorldPartitionStreaming = false;
	UWorld* World = Cast<UWorld>(Factory->FactoryCreateNew(UWorld::StaticClass(), Package,
		MapHistoryAssetName, RF_Public | RF_Standalone, nullptr, GWarn));
	if (World == nullptr || !World->IsPartitionedWorld()) return false;

	auto AddActor = [&](const TCHAR* Label, const FVector& Location, const FVector& Scale,
		const FLinearColor& Color) -> AStaticMeshActor*
	{
		FActorSpawnParameters Spawn;
		Spawn.bCreateActorPackage = true;
		AStaticMeshActor* Actor = World->SpawnActor<AStaticMeshActor>(
			Location, FRotator::ZeroRotator, Spawn);
		if (Actor == nullptr) return nullptr;
		Actor->Tags.Add(TEXT("UEShedMapHistoryFixture"));
		Actor->SetActorLabel(Label);
		Actor->GetStaticMeshComponent()->SetStaticMesh(LoadObject<UStaticMesh>(nullptr,
			TEXT("/Engine/BasicShapes/Cube.Cube")));
		Actor->SetActorScale3D(Scale);
		ApplySolidColor(Actor->GetStaticMeshComponent(), Color);
		return Actor;
	};

	AStaticMeshActor* Hub = AddActor(TEXT("History Hub"), FVector(-1200, -450, 120),
		FVector(4.0, 4.0, 2.0), FLinearColor(0.32f, 0.68f, 0.82f, 1.0f));
	AStaticMeshActor* East = AddActor(TEXT("East Marker"), FVector(900, -320, 200),
		FVector(1.3, 1.3, 3.5), FLinearColor(0.94f, 0.58f, 0.24f, 1.0f));
	AStaticMeshActor* North = AddActor(TEXT("North Marker"), FVector(-220, 1300, 160),
		FVector(2.6, 1.0, 1.0), FLinearColor(0.72f, 0.42f, 0.78f, 1.0f));
	AStaticMeshActor* South = AddActor(TEXT("South Marker"), FVector(-500, -1500, 80),
		FVector(1.0, 3.0, 1.0), FLinearColor(0.42f, 0.76f, 0.44f, 1.0f));
	AStaticMeshActor* West = AddActor(TEXT("West Marker"), FVector(-2050, 660, 260),
		FVector(1.8, 1.8, 1.8), FLinearColor(0.86f, 0.34f, 0.38f, 1.0f));
	AStaticMeshActor* Attached = AddActor(TEXT("Hub Attachment"), FVector::ZeroVector,
		FVector(0.6, 0.6, 3.0), FLinearColor(0.96f, 0.88f, 0.30f, 1.0f));
	if (Hub == nullptr || East == nullptr || North == nullptr || South == nullptr || West == nullptr
		|| Attached == nullptr)
	{
		World->CleanupWorld();
		DeleteMapHistoryWorkingFiles();
		return false;
	}
	Attached->AttachToComponent(Hub->GetRootComponent(), FAttachmentTransformRules::KeepRelativeTransform);
	Attached->SetActorRelativeLocation(FVector(760, 260, 480));

	Package->MarkPackageDirty();
	bool bSucceeded = SaveAsset(Package, World);
	for (AStaticMeshActor* Actor : { Hub, East, North, South, West, Attached })
	{
		bSucceeded = SaveExternalActor(Actor) && bSucceeded;
	}
	TArray<FString> BaselineFiles = { MapHistoryRelativePath, ExternalActorProjectPath(Hub),
		ExternalActorProjectPath(East), ExternalActorProjectPath(North), ExternalActorProjectPath(South),
		ExternalActorProjectPath(West), ExternalActorProjectPath(Attached) };
	bSucceeded = !Algo::AnyOf(BaselineFiles, [](const FString& File) { return File.IsEmpty(); })
		&& bSucceeded;
	bSucceeded = SnapshotMapHistoryRevision(OutputDirectory, TEXT("baseline"), MapHistoryPackageName, true,
		{ Hub, East, North, South, West, Attached }) && bSucceeded;

	East->SetActorLocation(FVector(1450, -320, 260));
	bSucceeded = SaveExternalActor(East) && bSucceeded;
	bSucceeded = SnapshotMapHistoryRevision(OutputDirectory, TEXT("move-east"), MapHistoryPackageName, false, { East })
		&& bSucceeded;

	North->SetActorLabel(TEXT("North Beacon"));
	bSucceeded = SaveExternalActor(North) && bSucceeded;
	bSucceeded = SnapshotMapHistoryRevision(OutputDirectory, TEXT("label-north"), MapHistoryPackageName, false, { North })
		&& bSucceeded;

	AStaticMeshActor* Arrival = AddActor(TEXT("Arrival Marker"), FVector(480, 760, 140),
		FVector(1.1, 1.1, 1.1), FLinearColor(0.30f, 0.88f, 0.64f, 1.0f));
	const FString ArrivalFile = ExternalActorProjectPath(Arrival);
	bSucceeded = SaveExternalActor(Arrival) && bSucceeded;
	bSucceeded = SnapshotMapHistoryRevision(OutputDirectory, TEXT("add-arrival"), MapHistoryPackageName, false,
		{ Arrival })
		&& bSucceeded;

	const FString SouthFile = ExternalActorProjectPath(South);
	const FString SouthPackage = South->GetExternalPackage() == nullptr ? FString()
		: South->GetExternalPackage()->GetName();
	World->EditorDestroyActor(South, true);
	bSucceeded = !SouthPackage.IsEmpty() && DeletePackageFiles(SouthPackage, false) && bSucceeded;
	bSucceeded = SnapshotMapHistoryRevision(OutputDirectory, TEXT("delete-south"), MapHistoryPackageName, false, {})
		&& bSucceeded;

	East->SetActorScale3D(FVector(2.1, 1.3, 3.5));
	West->SetActorScale3D(FVector(1.8, 2.4, 1.8));
	bSucceeded = SaveExternalActor(East) && SaveExternalActor(West) && bSucceeded;
	bSucceeded = SnapshotMapHistoryRevision(OutputDirectory,
		TEXT("two-unclassified-package-edits"), MapHistoryPackageName, false, { East, West })
		&& bSucceeded;
	bSucceeded = !ArrivalFile.IsEmpty() && !SouthFile.IsEmpty() && WriteMapHistoryScenarioManifest(
		OutputDirectory, BaselineFiles, ExternalActorProjectPath(East), ExternalActorProjectPath(North),
		ArrivalFile, SouthFile, ExternalActorProjectPath(West)) && bSucceeded;

	World->CleanupWorld();
	bSucceeded = GenerateConventionalMapHistoryFixture(OutputDirectory) && bSucceeded;
	CollectGarbage(GARBAGE_COLLECTION_KEEPFLAGS);
	DeleteMapHistoryWorkingFiles();
	if (bSucceeded)
	{
		UE_LOG(LogTemp, Display, TEXT("Generated Map History fixture at %s with %d baseline actors"),
			*OutputDirectory, MapHistoryActorCount);
	}
	return bSucceeded;
}

bool VerifyOfflineWorldMap()
{
	static const TCHAR* PackageName = TEXT("/Game/Fixture/Offline/L_OfflineWorld");
	UPackage* Package = LoadPackage(nullptr, PackageName, LOAD_None);
	UWorld* World = Package == nullptr ? nullptr : UWorld::FindWorldInPackage(Package);
	if (World == nullptr || !World->IsPartitionedWorld()) return false;
	const FString ExternalActorRoot = FPaths::Combine(FPaths::ProjectContentDir(),
		TEXT("__ExternalActors__/Fixture/Offline/L_OfflineWorld"));
	TArray<FString> Packages;
	IFileManager::Get().FindFilesRecursive(Packages, *ExternalActorRoot, TEXT("*.uasset"), true, false);
	UE_LOG(LogTemp, Display, TEXT("Offline World Partition fixture verification found %d external actor packages"),
		Packages.Num());
	return Packages.Num() >= OfflineWorldActorCount;
}

bool GenerateCameraMap()
{
	static const TCHAR* PackageName = TEXT("/Game/Fixture/Cameras/L_CameraLoad");
	static const TCHAR* AssetName = TEXT("L_CameraLoad");
	UPackage* Package = FindOrCreatePackage(PackageName);
	if (Package == nullptr) return false;
	UWorld* World = UWorld::FindWorldInPackage(Package);
	const bool bCreatedWorld = World == nullptr;
	if (World == nullptr)
	{
		UWorldFactory* Factory = NewObject<UWorldFactory>();
		Factory->WorldType = EWorldType::Editor;
		Factory->bCreateWorldPartition = false;
		World = Cast<UWorld>(Factory->FactoryCreateNew(UWorld::StaticClass(), Package, AssetName,
			RF_Public | RF_Standalone, nullptr, GWarn));
	}
	if (World == nullptr) return false;
	if (!bCreatedWorld)
	{
		int32 ExistingMovers = 0;
		int32 ExistingCameras = 0;
		int32 StationaryMovers = 0;
		int32 FlyingMovers = 0;
		int32 IntermittentMovers = 0;
		bool bMoverMotionsMatch = true;
		bool bHasReviewSubject = false;
		bool bHasTranslucentReviewSubject = false;
		bool bHasReviewOccluder = false;
		bool bHasAtmosphere = false;
		bool bAllCamerasBound = true;
		for (AActor* Actor : World->PersistentLevel->Actors)
		{
			if (Actor == nullptr) continue;
			bHasAtmosphere = bHasAtmosphere || Actor->IsA<ASkyAtmosphere>();
			bHasReviewSubject = bHasReviewSubject || Actor->GetFName() == TEXT("ReviewSubject");
			bHasTranslucentReviewSubject = bHasTranslucentReviewSubject
				|| Actor->GetFName() == TEXT("ReviewTranslucentSubject");
			bHasReviewOccluder = bHasReviewOccluder || Actor->GetFName() == TEXT("ReviewOccluder");
			if (const AUEShedFixtureMover* Mover = Cast<AUEShedFixtureMover>(Actor))
			{
				++ExistingMovers;
				StationaryMovers += Mover->IsA<AUEShedFixtureStationary>() ? 1 : 0;
				FlyingMovers += Mover->IsA<AUEShedFixtureFlying>() ? 1 : 0;
				IntermittentMovers += Mover->IsA<AUEShedFixtureIntermittent>() ? 1 : 0;
				bMoverMotionsMatch = bMoverMotionsMatch
					&& (!Mover->IsA<AUEShedFixtureStationary>()
						|| Mover->Motion == EUEShedFixtureMotion::Stationary)
					&& (!Mover->IsA<AUEShedFixtureFlying>()
						|| Mover->Motion == EUEShedFixtureMotion::Flying)
					&& (!Mover->IsA<AUEShedFixtureIntermittent>()
						|| Mover->Motion == EUEShedFixtureMotion::Intermittent);
			}
			if (const AUEShedCameraSource* Camera = Cast<AUEShedCameraSource>(Actor))
			{
				++ExistingCameras;
				bAllCamerasBound = bAllCamerasBound && Camera->ObservationTarget != nullptr;
			}
		}
		const bool bFamiliesMatch = StationaryMovers == StationaryMoverCount
			&& FlyingMovers == FlyingMoverCount
			&& IntermittentMovers == IntermittentMoverCount;
		if (ExistingMovers == ObservationMoverCount && ExistingCameras == CameraFixtureCount
			&& bAllCamerasBound && bHasReviewSubject && bHasTranslucentReviewSubject
			&& bHasReviewOccluder && bHasAtmosphere
			&& bFamiliesMatch
			&& bMoverMotionsMatch)
		{
			UE_LOG(LogTemp, Display, TEXT("Camera fixture map already matches its contract"));
			return true;
		}
	}

	TArray<AActor*> Existing;
	for (AActor* Actor : World->PersistentLevel->Actors)
	{
		if (Actor == nullptr) continue;
		if (Actor->ActorHasTag(TEXT("UEShedCameraFixture"))
			|| Actor->IsA<AUEShedFixtureMover>()
			|| Actor->IsA<AUEShedCameraSource>()
			|| Actor->IsA<ASkyAtmosphere>()
			|| Actor->IsA<AExponentialHeightFog>()
			|| Actor->IsA<ADirectionalLight>()
			|| Actor->IsA<ASkyLight>()
			|| Actor->GetFName() == TEXT("ReviewSubject")
			|| Actor->ActorHasTag(TEXT("UEShedReviewSubject")))
		{
			Existing.Add(Actor);
		}
	}
	for (AActor* Actor : Existing)
	{
		Actor->Rename(nullptr, Actor->GetOuter(),
			REN_ForceNoResetLoaders | REN_DontCreateRedirectors | REN_NonTransactional);
		World->EditorDestroyActor(Actor, true);
	}

	AStaticMeshActor* Floor = World->SpawnActor<AStaticMeshActor>(FVector(0, 0, -80), FRotator::ZeroRotator);
	Floor->Tags.Add(TEXT("UEShedCameraFixture"));
	Floor->SetActorLabel(TEXT("Observation Floor"));
	Floor->GetStaticMeshComponent()->SetStaticMesh(LoadObject<UStaticMesh>(nullptr,
		TEXT("/Engine/BasicShapes/Plane.Plane")));
	Floor->SetActorScale3D(FVector(55, 55, 1));
	ApplySolidColor(Floor->GetStaticMeshComponent(), FLinearColor(0.18f, 0.22f, 0.17f, 1.0f));

	ADirectionalLight* Sun = World->SpawnActor<ADirectionalLight>(FVector::ZeroVector,
		FRotator(-48, -35, 0));
	Sun->Tags.Add(TEXT("UEShedCameraFixture"));
	Sun->SetActorLabel(TEXT("Fixture Sun"));
	if (UDirectionalLightComponent* SunLight = Cast<UDirectionalLightComponent>(Sun->GetLightComponent()))
	{
		SunLight->SetAtmosphereSunLight(true);
		SunLight->SetIntensity(8.0f);
		SunLight->SetLightColor(FLinearColor(1.0f, 0.96f, 0.90f));
	}

	ASkyAtmosphere* Atmosphere = World->SpawnActor<ASkyAtmosphere>();
	Atmosphere->Tags.Add(TEXT("UEShedCameraFixture"));
	Atmosphere->SetActorLabel(TEXT("Fixture Atmosphere"));

	ASkyLight* Sky = World->SpawnActor<ASkyLight>();
	Sky->Tags.Add(TEXT("UEShedCameraFixture"));
	Sky->SetActorLabel(TEXT("Fixture Sky"));
	if (USkyLightComponent* SkyLight = Sky->GetLightComponent())
	{
		SkyLight->bRealTimeCapture = true;
		SkyLight->SetIntensity(1.0f);
		SkyLight->RecaptureSky();
	}

	AExponentialHeightFog* Fog = World->SpawnActor<AExponentialHeightFog>(
		FVector(0, 0, -80), FRotator::ZeroRotator);
	Fog->Tags.Add(TEXT("UEShedCameraFixture"));
	Fog->SetActorLabel(TEXT("Fixture Fog"));
	if (UExponentialHeightFogComponent* FogComponent = Fog->GetComponent())
	{
		FogComponent->SetFogDensity(0.018f);
		FogComponent->SetFogHeightFalloff(0.18f);
		FogComponent->SetFogInscatteringColor(FLinearColor(0.45f, 0.58f, 0.78f));
	}

	FActorSpawnParameters ReviewSubjectSpawn;
	ReviewSubjectSpawn.Name = TEXT("ReviewSubject");
	ReviewSubjectSpawn.NameMode = FActorSpawnParameters::ESpawnActorNameMode::Required_ErrorAndReturnNull;
	AStaticMeshActor* ReviewSubject = World->SpawnActor<AStaticMeshActor>(
		FVector(0, 0, 140), FRotator::ZeroRotator, ReviewSubjectSpawn);
	if (ReviewSubject == nullptr) return false;
	ReviewSubject->Tags.Add(TEXT("UEShedCameraFixture"));
	ReviewSubject->Tags.Add(TEXT("UEShedReviewSubject"));
	ReviewSubject->SetActorLabel(TEXT("Review Subject"));
	ReviewSubject->GetStaticMeshComponent()->SetStaticMesh(LoadObject<UStaticMesh>(nullptr,
		TEXT("/Engine/BasicShapes/Cube.Cube")));
	ReviewSubject->SetActorScale3D(FVector(4.5, 2.8, 3.6));
	ApplySolidColor(ReviewSubject->GetStaticMeshComponent(),
		FLinearColor(0.62f, 0.56f, 0.48f, 1.0f));
	AddChildShape(ReviewSubject, TEXT("Roof"), TEXT("/Engine/BasicShapes/Cube.Cube"),
		FVector(0, 0, 70), FVector(1.15, 1.2, 0.22), FLinearColor(0.32f, 0.28f, 0.26f, 1.0f));
	AddChildShape(ReviewSubject, TEXT("FacadeWing"), TEXT("/Engine/BasicShapes/Cube.Cube"),
		FVector(70, 0, -10), FVector(0.55, 0.9, 0.7), FLinearColor(0.72f, 0.64f, 0.52f, 1.0f));
	AddChildShape(ReviewSubject, TEXT("Tower"), TEXT("/Engine/BasicShapes/Cylinder.Cylinder"),
		FVector(-55, 35, 35), FVector(0.45, 0.45, 1.1), FLinearColor(0.48f, 0.52f, 0.58f, 1.0f));

	FActorSpawnParameters TranslucentSubjectSpawn;
	TranslucentSubjectSpawn.Name = TEXT("ReviewTranslucentSubject");
	TranslucentSubjectSpawn.NameMode =
		FActorSpawnParameters::ESpawnActorNameMode::Required_ErrorAndReturnNull;
	AStaticMeshActor* TranslucentSubject = World->SpawnActor<AStaticMeshActor>(
		FVector(0, -1600, 140), FRotator::ZeroRotator, TranslucentSubjectSpawn);
	UMaterialInterface* TranslucentMaterial = LoadObject<UMaterialInterface>(nullptr,
		TEXT("/Engine/EngineDebugMaterials/M_SimpleTranslucent.M_SimpleTranslucent"));
	if (TranslucentSubject == nullptr || TranslucentMaterial == nullptr) return false;
	TranslucentSubject->Tags.Add(TEXT("UEShedCameraFixture"));
	TranslucentSubject->Tags.Add(TEXT("UEShedReviewSubject"));
	TranslucentSubject->SetActorLabel(TEXT("Review Translucent Subject"));
	TranslucentSubject->GetStaticMeshComponent()->SetStaticMesh(LoadObject<UStaticMesh>(nullptr,
		TEXT("/Engine/BasicShapes/Cube.Cube")));
	TranslucentSubject->SetActorScale3D(FVector(3.2, 3.2, 3.2));
	TranslucentSubject->GetStaticMeshComponent()->SetMaterial(0, TranslucentMaterial);

	FActorSpawnParameters ReviewOccluderSpawn;
	ReviewOccluderSpawn.Name = TEXT("ReviewOccluder");
	ReviewOccluderSpawn.NameMode = FActorSpawnParameters::ESpawnActorNameMode::Required_ErrorAndReturnNull;
	AStaticMeshActor* Occluder = World->SpawnActor<AStaticMeshActor>(
		FVector(420, -280, 80), FRotator(0, 25, 0), ReviewOccluderSpawn);
	if (Occluder == nullptr) return false;
	Occluder->Tags.Add(TEXT("UEShedCameraFixture"));
	Occluder->SetActorLabel(TEXT("Review Occluder"));
	Occluder->GetStaticMeshComponent()->SetStaticMesh(LoadObject<UStaticMesh>(nullptr,
		TEXT("/Engine/BasicShapes/Cube.Cube")));
	Occluder->SetActorScale3D(FVector(1.8, 6.0, 3.2));
	ApplySolidColor(Occluder->GetStaticMeshComponent(), FLinearColor(0.22f, 0.24f, 0.26f, 1.0f));

	TArray<AUEShedFixtureMover*> Movers;
	Movers.Reserve(ObservationMoverCount);
	constexpr int32 GridSide = 64; // 64 * 64 == ObservationMoverCount
	constexpr double GridSpacing = 220.0;
	const double GridOrigin = -0.5 * (GridSide - 1) * GridSpacing;

	for (int32 Index = 0; Index < ObservationMoverCount; ++Index)
	{
		const int32 GridX = Index % GridSide;
		const int32 GridY = Index / GridSide;
		// Exact 80% stationary / 10% flying / 10% intermittent split after rounding.
		const EUEShedFixtureMotion Motion = Index < StationaryMoverCount
			? EUEShedFixtureMotion::Stationary
			: Index < StationaryMoverCount + FlyingMoverCount
				? EUEShedFixtureMotion::Flying
				: EUEShedFixtureMotion::Intermittent;
		const FVector Origin(
			GridOrigin + GridX * GridSpacing,
			GridOrigin + GridY * GridSpacing,
			MotionBaseHeight(Motion));
		UClass* MoverClass = Motion == EUEShedFixtureMotion::Stationary
			? AUEShedFixtureStationary::StaticClass()
			: Motion == EUEShedFixtureMotion::Flying
				? AUEShedFixtureFlying::StaticClass()
				: AUEShedFixtureIntermittent::StaticClass();
		AUEShedFixtureMover* Mover = World->SpawnActor<AUEShedFixtureMover>(
			MoverClass, Origin, FRotator::ZeroRotator);
		Mover->Tags.Add(TEXT("UEShedCameraFixture"));
		Mover->LogicalIndex = Index;
		const int32 MotionVariant = Index % 32;
		Mover->Radius = Motion == EUEShedFixtureMotion::Flying
			? 220.0f + MotionVariant * 12.0f
			: 180.0f + MotionVariant * 18.0f;
		Mover->Speed = Motion == EUEShedFixtureMotion::Flying
			? 0.35f + MotionVariant * 0.04f
			: 0.45f + MotionVariant * 0.055f;
		Mover->IntermittentPeriod = 2.6f + (Index % 5) * 0.35f;
		Mover->IntermittentDutyCycle = 0.45f + (Index % 4) * 0.08f;
		Mover->ApplyVisualIdentity();
		Mover->SetActorLabel(FString::Printf(TEXT("%s %04d"), MotionFamilyLabel(Motion), Index + 1));
		Movers.Add(Mover);
	}

	for (int32 Index = 0; Index < CameraFixtureCount; ++Index)
	{
		AUEShedFixtureMover* Mover = Movers[Index];
		const double Angle = UE_TWO_PI * Index / CameraFixtureCount;
		const FVector CameraLocation(FMath::Cos(Angle) * 2600.0,
			FMath::Sin(Angle) * 2600.0, 1150.0 + (Index % 2) * 250.0);
		const FRotator CameraRotation = (Mover->GetActorLocation() - CameraLocation).Rotation();
		AUEShedCameraSource* Camera = World->SpawnActor<AUEShedCameraSource>(
			CameraLocation, CameraRotation);
		Camera->Tags.Add(TEXT("UEShedCameraFixture"));
		Camera->CameraIndex = Index;
		Camera->CameraId = FGuid(0x55455348, 0x45444341, 0x4D000000 | Index, 0x00000001);
		Camera->ObservationTarget = Mover;
		Camera->SetActorLabel(FString::Printf(TEXT("Camera %02d"), Index + 1));
	}

	Package->MarkPackageDirty();
	const bool bSaved = SaveAsset(Package, World);
	if (bCreatedWorld) World->CleanupWorld();
	if (!bSaved) return false;
	UE_LOG(LogTemp, Display, TEXT("Generated %s with %d movers and %d camera sources"),
		PackageName, ObservationMoverCount, CameraFixtureCount);
	return true;
}

bool VerifyCameraMap()
{
	UPackage* Package = LoadPackage(nullptr, TEXT("/Game/Fixture/Cameras/L_CameraLoad"), LOAD_None);
	UWorld* World = Package == nullptr ? nullptr : UWorld::FindWorldInPackage(Package);
	if (World == nullptr) return false;
	int32 Movers = 0;
	int32 Cameras = 0;
	int32 BoundCameras = 0;
	int32 StationaryMovers = 0;
	int32 FlyingMovers = 0;
	int32 IntermittentMovers = 0;
	bool bMoverMotionsMatch = true;
	bool bHasReviewSubject = false;
	bool bHasTranslucentReviewSubject = false;
	bool bHasReviewOccluder = false;
	bool bHasAtmosphere = false;
	for (AActor* Actor : World->PersistentLevel->Actors)
	{
		if (Actor == nullptr) continue;
		bHasAtmosphere = bHasAtmosphere || Actor->IsA<ASkyAtmosphere>();
		bHasReviewSubject = bHasReviewSubject || Actor->GetFName() == TEXT("ReviewSubject");
	bHasTranslucentReviewSubject = bHasTranslucentReviewSubject
		|| Actor->GetFName() == TEXT("ReviewTranslucentSubject");
	bHasReviewOccluder = bHasReviewOccluder || Actor->GetFName() == TEXT("ReviewOccluder");
		if (const AUEShedFixtureMover* Mover = Cast<AUEShedFixtureMover>(Actor))
		{
			++Movers;
			StationaryMovers += Mover->IsA<AUEShedFixtureStationary>() ? 1 : 0;
			FlyingMovers += Mover->IsA<AUEShedFixtureFlying>() ? 1 : 0;
			IntermittentMovers += Mover->IsA<AUEShedFixtureIntermittent>() ? 1 : 0;
			bMoverMotionsMatch = bMoverMotionsMatch
				&& (!Mover->IsA<AUEShedFixtureStationary>()
					|| Mover->Motion == EUEShedFixtureMotion::Stationary)
				&& (!Mover->IsA<AUEShedFixtureFlying>()
					|| Mover->Motion == EUEShedFixtureMotion::Flying)
				&& (!Mover->IsA<AUEShedFixtureIntermittent>()
					|| Mover->Motion == EUEShedFixtureMotion::Intermittent);
		}
		if (const AUEShedCameraSource* Camera = Cast<AUEShedCameraSource>(Actor))
		{
			++Cameras;
			BoundCameras += Camera->ObservationTarget != nullptr ? 1 : 0;
		}
	}
	UE_LOG(LogTemp, Display,
		TEXT("Camera fixture verification found %d movers (%d stationary / %d flying / %d intermittent), %d cameras, opaque review subject=%s, translucent review subject=%s, review occluder=%s, atmosphere=%s"),
		Movers, StationaryMovers, FlyingMovers, IntermittentMovers, Cameras,
		bHasReviewSubject ? TEXT("yes") : TEXT("no"),
		bHasTranslucentReviewSubject ? TEXT("yes") : TEXT("no"),
		bHasReviewOccluder ? TEXT("yes") : TEXT("no"),
		bHasAtmosphere ? TEXT("yes") : TEXT("no"));
	return Movers == ObservationMoverCount && Cameras == CameraFixtureCount
		&& BoundCameras == CameraFixtureCount && bHasReviewSubject && bHasTranslucentReviewSubject
		&& bHasReviewOccluder && bHasAtmosphere
		&& StationaryMovers == StationaryMoverCount && FlyingMovers == FlyingMoverCount
		&& IntermittentMovers == IntermittentMoverCount && bMoverMotionsMatch;
}

struct FMapReviewGalleryActorDefinition
{
	const TCHAR* Name;
	const TCHAR* Label;
	const TCHAR* MeshPath;
	FVector Location;
	FRotator Rotation;
	FVector Scale;
	FLinearColor Color;
	bool bSubject = false;
	bool bTranslucent = false;
};

const TArray<FMapReviewGalleryActorDefinition>& MapReviewGalleryActors()
{
	static const TArray<FMapReviewGalleryActorDefinition> Definitions = {
		{ TEXT("MapReviewCompact"), TEXT("Compact Subject"), TEXT("/Engine/BasicShapes/Cube.Cube"),
			FVector(0, 0, 90), FRotator::ZeroRotator, FVector(1.6, 1.6, 1.8),
			FLinearColor(0.72f, 0.52f, 0.30f, 1.0f), true },
		{ TEXT("MapReviewTall"), TEXT("Tall Subject"), TEXT("/Engine/BasicShapes/Cylinder.Cylinder"),
			FVector(0, 2200, 260), FRotator::ZeroRotator, FVector(1.5, 1.5, 5.2),
			FLinearColor(0.35f, 0.58f, 0.72f, 1.0f), true },
		{ TEXT("MapReviewWide"), TEXT("Wide Subject"), TEXT("/Engine/BasicShapes/Cube.Cube"),
			FVector(0, 4400, 85), FRotator::ZeroRotator, FVector(6.0, 1.4, 1.7),
			FLinearColor(0.62f, 0.68f, 0.34f, 1.0f), true },
		{ TEXT("MapReviewAsymmetric"), TEXT("Rotated Asymmetric Subject"),
			TEXT("/Engine/BasicShapes/Cube.Cube"), FVector(3000, 0, 120), FRotator(0, 35, 0),
			FVector(3.2, 1.8, 2.4), FLinearColor(0.68f, 0.42f, 0.52f, 1.0f), true },
		{ TEXT("MapReviewCompound"), TEXT("Compound Subject"), TEXT("/Engine/BasicShapes/Cube.Cube"),
			FVector(3000, 2200, 140), FRotator(0, -20, 0), FVector(3.8, 2.6, 2.8),
			FLinearColor(0.58f, 0.54f, 0.46f, 1.0f), true },
		{ TEXT("MapReviewClear"), TEXT("Unobstructed Subject"), TEXT("/Engine/BasicShapes/Sphere.Sphere"),
			FVector(6000, 0, 150), FRotator::ZeroRotator, FVector(3.0),
			FLinearColor(0.38f, 0.72f, 0.52f, 1.0f), true },
		{ TEXT("MapReviewPartial"), TEXT("Partially Occluded Subject"),
			TEXT("/Engine/BasicShapes/Cube.Cube"), FVector(6000, 2200, 160), FRotator(0, 15, 0),
			FVector(3.2), FLinearColor(0.42f, 0.64f, 0.76f, 1.0f), true },
		{ TEXT("MapReviewPartialOccluder"), TEXT("Partial Occluder"),
			TEXT("/Engine/BasicShapes/Cube.Cube"), FVector(5500, 2330, 120), FRotator(0, -10, 0),
			FVector(1.4, 2.4, 2.4), FLinearColor(0.20f, 0.22f, 0.25f, 1.0f) },
		{ TEXT("MapReviewFull"), TEXT("Fully Occluded Subject"), TEXT("/Engine/BasicShapes/Sphere.Sphere"),
			FVector(6000, 4400, 150), FRotator::ZeroRotator, FVector(3.0),
			FLinearColor(0.74f, 0.40f, 0.32f, 1.0f), true },
		{ TEXT("MapReviewFullOccluder"), TEXT("Full Occluder"), TEXT("/Engine/BasicShapes/Cube.Cube"),
			FVector(5480, 4400, 180), FRotator::ZeroRotator, FVector(1.8, 4.6, 3.6),
			FLinearColor(0.18f, 0.20f, 0.23f, 1.0f) },
		{ TEXT("MapReviewTranslucent"), TEXT("Translucent Subject"),
			TEXT("/Engine/BasicShapes/Cube.Cube"), FVector(9000, 0, 160), FRotator(0, 25, 0),
			FVector(3.2), FLinearColor::White, true, true },
		{ TEXT("MapReviewEnclosed"), TEXT("Enclosed Subject"), TEXT("/Engine/BasicShapes/Cylinder.Cylinder"),
			FVector(9000, 2200, 180), FRotator::ZeroRotator, FVector(2.4, 2.4, 3.6),
			FLinearColor(0.70f, 0.58f, 0.30f, 1.0f), true },
		{ TEXT("MapReviewEnclosureSide"), TEXT("Enclosure Side Wall"),
			TEXT("/Engine/BasicShapes/Cube.Cube"), FVector(9000, 2560, 220), FRotator::ZeroRotator,
			FVector(6.0, 0.5, 4.4), FLinearColor(0.24f, 0.28f, 0.32f, 1.0f) },
		{ TEXT("MapReviewEnclosureBack"), TEXT("Enclosure Back Wall"),
			TEXT("/Engine/BasicShapes/Cube.Cube"), FVector(9360, 2200, 220), FRotator::ZeroRotator,
			FVector(0.5, 6.0, 4.4), FLinearColor(0.24f, 0.28f, 0.32f, 1.0f) },
		{ TEXT("MapReviewEnclosureRoof"), TEXT("Enclosure Roof"),
			TEXT("/Engine/BasicShapes/Cube.Cube"), FVector(9000, 2200, 480), FRotator::ZeroRotator,
			FVector(6.0, 6.0, 0.45), FLinearColor(0.20f, 0.23f, 0.27f, 1.0f) },
		{ TEXT("MapReviewForegroundColumn"), TEXT("Foreground Column"),
			TEXT("/Engine/BasicShapes/Cylinder.Cylinder"), FVector(8520, 2050, 220), FRotator::ZeroRotator,
			FVector(1.1, 1.1, 4.4), FLinearColor(0.28f, 0.30f, 0.34f, 1.0f) }
	};
	return Definitions;
}

bool VerifyMapReviewGalleryWorld(UWorld* World, const bool bLog)
{
	if (World == nullptr) return false;
	int32 FixtureActors = 0;
	int32 Subjects = 0;
	bool bHasAtmosphere = false;
	bool bHasSun = false;
	bool bHasSky = false;
	bool bHasFloor = false;
	bool bMatches = true;
	for (AActor* Actor : World->PersistentLevel->Actors)
	{
		if (Actor == nullptr) continue;
		if (Actor->ActorHasTag(TEXT("UEShedMapReviewFixture"))) ++FixtureActors;
		Subjects += Actor->ActorHasTag(TEXT("UEShedReviewSubject")) ? 1 : 0;
		bHasAtmosphere = bHasAtmosphere || Actor->IsA<ASkyAtmosphere>();
		bHasSun = bHasSun || Actor->IsA<ADirectionalLight>();
		bHasSky = bHasSky || Actor->IsA<ASkyLight>();
		bHasFloor = bHasFloor || Actor->GetFName() == TEXT("MapReviewFloor");
	}
	for (const FMapReviewGalleryActorDefinition& Definition : MapReviewGalleryActors())
	{
		AActor* Actor = FindObject<AActor>(World->PersistentLevel, Definition.Name);
		if (Actor == nullptr)
		{
			if (bLog) UE_LOG(LogTemp, Error, TEXT("Map Review gallery actor is missing: %s"), Definition.Name);
			bMatches = false;
			continue;
		}
		const USceneComponent* Root = Actor->GetRootComponent();
		if (Root == nullptr)
		{
			if (bLog) UE_LOG(LogTemp, Error, TEXT("Map Review gallery actor has no root: %s"), Definition.Name);
			bMatches = false;
			continue;
		}
		const bool bActorMatches = Actor->ActorHasTag(TEXT("UEShedMapReviewFixture"))
			&& Root->GetRelativeLocation().Equals(Definition.Location, 0.01)
			&& Root->GetRelativeRotation().Equals(Definition.Rotation, 0.01)
			&& Root->GetRelativeScale3D().Equals(Definition.Scale, 0.001)
			&& Actor->ActorHasTag(TEXT("UEShedReviewSubject")) == Definition.bSubject;
		if (bLog && !bActorMatches)
		{
			UE_LOG(LogTemp, Error,
				TEXT("Map Review gallery actor mismatch %s: location=%s rotation=%s scale=%s fixtureTag=%s subjectTag=%s"),
				Definition.Name, *Root->GetRelativeLocation().ToString(), *Root->GetRelativeRotation().ToString(),
				*Root->GetRelativeScale3D().ToString(),
				Actor->ActorHasTag(TEXT("UEShedMapReviewFixture")) ? TEXT("yes") : TEXT("no"),
				Actor->ActorHasTag(TEXT("UEShedReviewSubject")) ? TEXT("yes") : TEXT("no"));
		}
		bMatches = bMatches && bActorMatches;
	}
	AActor* Compound = FindObject<AActor>(World->PersistentLevel, TEXT("MapReviewCompound"));
	const bool bCompoundMatches = Compound != nullptr
		&& FindObject<UStaticMeshComponent>(Compound, TEXT("GalleryWing")) != nullptr
		&& FindObject<UStaticMeshComponent>(Compound, TEXT("GalleryTower")) != nullptr
		&& FindObject<UStaticMeshComponent>(Compound, TEXT("GalleryRoof")) != nullptr;
	if (bLog && !bCompoundMatches)
	{
		UE_LOG(LogTemp, Error, TEXT("Map Review compound child component contract does not match"));
	}
	bMatches = bMatches && bCompoundMatches;
	const int32 ExpectedFixtureActors = MapReviewGalleryActors().Num() + 4;
	if (bLog)
	{
		UE_LOG(LogTemp, Display,
			TEXT("Map Review gallery verification found %d fixture actors, %d subjects, atmosphere=%s, sun=%s, sky=%s, floor=%s"),
			FixtureActors, Subjects, bHasAtmosphere ? TEXT("yes") : TEXT("no"),
			bHasSun ? TEXT("yes") : TEXT("no"), bHasSky ? TEXT("yes") : TEXT("no"),
			bHasFloor ? TEXT("yes") : TEXT("no"));
	}
	return bMatches && FixtureActors == ExpectedFixtureActors && Subjects == 10
		&& bHasAtmosphere && bHasSun && bHasSky && bHasFloor;
}

bool GenerateMapReviewGallery()
{
	static const TCHAR* PackageName = TEXT("/Game/Fixture/MapReview/L_MapReviewFixture");
	static const TCHAR* AssetName = TEXT("L_MapReviewFixture");
	UPackage* Package = FindOrCreatePackage(PackageName);
	if (Package == nullptr) return false;
	UWorld* World = UWorld::FindWorldInPackage(Package);
	const bool bCreatedWorld = World == nullptr;
	if (World == nullptr)
	{
		UWorldFactory* Factory = NewObject<UWorldFactory>();
		Factory->WorldType = EWorldType::Editor;
		Factory->bCreateWorldPartition = false;
		World = Cast<UWorld>(Factory->FactoryCreateNew(UWorld::StaticClass(), Package, AssetName,
			RF_Public | RF_Standalone, nullptr, GWarn));
	}
	if (World == nullptr) return false;
	if (!bCreatedWorld && VerifyMapReviewGalleryWorld(World, false))
	{
		UE_LOG(LogTemp, Display, TEXT("Map Review fixture gallery already matches its contract"));
		return true;
	}

	TArray<AActor*> Existing;
	for (AActor* Actor : World->PersistentLevel->Actors)
	{
		if (Actor != nullptr && Actor->ActorHasTag(TEXT("UEShedMapReviewFixture"))) Existing.Add(Actor);
	}
	for (AActor* Actor : Existing)
	{
		Actor->Rename(nullptr, Actor->GetOuter(),
			REN_ForceNoResetLoaders | REN_DontCreateRedirectors | REN_NonTransactional);
		World->EditorDestroyActor(Actor, true);
	}

	FActorSpawnParameters FloorSpawn;
	FloorSpawn.Name = TEXT("MapReviewFloor");
	FloorSpawn.NameMode = FActorSpawnParameters::ESpawnActorNameMode::Required_ErrorAndReturnNull;
	AStaticMeshActor* Floor = World->SpawnActor<AStaticMeshActor>(
		FVector(4500, 2200, -20), FRotator::ZeroRotator, FloorSpawn);
	if (Floor == nullptr) return false;
	Floor->Tags.Add(TEXT("UEShedMapReviewFixture"));
	Floor->SetActorLabel(TEXT("Map Review Gallery Floor"));
	Floor->GetStaticMeshComponent()->SetStaticMesh(LoadObject<UStaticMesh>(nullptr,
		TEXT("/Engine/BasicShapes/Plane.Plane")));
	Floor->SetActorScale3D(FVector(110, 70, 1));
	ApplySolidColor(Floor->GetStaticMeshComponent(), FLinearColor(0.16f, 0.18f, 0.20f, 1.0f));

	ADirectionalLight* Sun = World->SpawnActor<ADirectionalLight>(FVector::ZeroVector, FRotator(-45, -30, 0));
	ASkyAtmosphere* Atmosphere = World->SpawnActor<ASkyAtmosphere>();
	ASkyLight* Sky = World->SpawnActor<ASkyLight>();
	if (Sun == nullptr || Atmosphere == nullptr || Sky == nullptr) return false;
	for (AActor* Environment : { static_cast<AActor*>(Sun), static_cast<AActor*>(Atmosphere), static_cast<AActor*>(Sky) })
	{
		Environment->Tags.Add(TEXT("UEShedMapReviewFixture"));
	}
	Sun->SetActorLabel(TEXT("Map Review Gallery Sun"));
	Atmosphere->SetActorLabel(TEXT("Map Review Gallery Atmosphere"));
	Sky->SetActorLabel(TEXT("Map Review Gallery Sky"));
	if (UDirectionalLightComponent* Light = Cast<UDirectionalLightComponent>(Sun->GetLightComponent()))
	{
		Light->SetAtmosphereSunLight(true);
		Light->SetIntensity(7.0f);
	}
	if (USkyLightComponent* SkyLight = Sky->GetLightComponent())
	{
		SkyLight->bRealTimeCapture = true;
		SkyLight->SetIntensity(1.0f);
		SkyLight->RecaptureSky();
	}

	UMaterialInterface* TranslucentMaterial = LoadObject<UMaterialInterface>(nullptr,
		TEXT("/Engine/EngineDebugMaterials/M_SimpleTranslucent.M_SimpleTranslucent"));
	if (TranslucentMaterial == nullptr) return false;
	for (const FMapReviewGalleryActorDefinition& Definition : MapReviewGalleryActors())
	{
		FActorSpawnParameters Spawn;
		Spawn.Name = Definition.Name;
		Spawn.NameMode = FActorSpawnParameters::ESpawnActorNameMode::Required_ErrorAndReturnNull;
		AStaticMeshActor* Actor = World->SpawnActor<AStaticMeshActor>(
			Definition.Location, Definition.Rotation, Spawn);
		if (Actor == nullptr) return false;
		Actor->Tags.Add(TEXT("UEShedMapReviewFixture"));
		if (Definition.bSubject) Actor->Tags.Add(TEXT("UEShedReviewSubject"));
		Actor->SetActorLabel(Definition.Label);
		Actor->GetStaticMeshComponent()->SetStaticMesh(
			LoadObject<UStaticMesh>(nullptr, Definition.MeshPath));
		Actor->SetActorScale3D(Definition.Scale);
		if (Definition.bTranslucent)
		{
			Actor->GetStaticMeshComponent()->SetMaterial(0, TranslucentMaterial);
		}
		else
		{
			ApplySolidColor(Actor->GetStaticMeshComponent(), Definition.Color);
		}
		if (FCString::Strcmp(Definition.Name, TEXT("MapReviewAsymmetric")) == 0)
		{
			AddChildShape(Actor, TEXT("GalleryOffset"), TEXT("/Engine/BasicShapes/Cube.Cube"),
				FVector(95, 45, 25), FVector(0.55, 1.0, 1.5), FLinearColor(0.84f, 0.62f, 0.34f, 1.0f));
		}
		if (FCString::Strcmp(Definition.Name, TEXT("MapReviewCompound")) == 0)
		{
			AddChildShape(Actor, TEXT("GalleryWing"), TEXT("/Engine/BasicShapes/Cube.Cube"),
				FVector(100, 0, -15), FVector(0.75, 1.2, 0.8), FLinearColor(0.72f, 0.60f, 0.42f, 1.0f));
			AddChildShape(Actor, TEXT("GalleryTower"), TEXT("/Engine/BasicShapes/Cylinder.Cylinder"),
				FVector(-90, 45, 70), FVector(0.55, 0.55, 1.5), FLinearColor(0.38f, 0.48f, 0.62f, 1.0f));
			AddChildShape(Actor, TEXT("GalleryRoof"), TEXT("/Engine/BasicShapes/Cube.Cube"),
				FVector(0, 0, 95), FVector(1.25, 1.25, 0.20), FLinearColor(0.28f, 0.26f, 0.24f, 1.0f));
		}
	}

	Package->MarkPackageDirty();
	const bool bSaved = SaveAsset(Package, World);
	if (bCreatedWorld) World->CleanupWorld();
	if (!bSaved) return false;
	UE_LOG(LogTemp, Display, TEXT("Generated %s with %d gallery actors"),
		PackageName, MapReviewGalleryActors().Num());
	return true;
}

bool VerifyMapReviewGallery()
{
	UPackage* Package = LoadPackage(nullptr, TEXT("/Game/Fixture/MapReview/L_MapReviewFixture"), LOAD_None);
	UWorld* World = Package == nullptr ? nullptr : UWorld::FindWorldInPackage(Package);
	return VerifyMapReviewGalleryWorld(World, true);
}

constexpr TCHAR MovementGymPackageName[] =
	TEXT("/Game/Fixture/Scenarios/L_MovementGym");
constexpr TCHAR MovementGymAssetName[] = TEXT("L_MovementGym");

bool VerifyMovementGymWorld(UWorld* World, const bool bLog)
{
	if (World == nullptr || World->IsPartitionedWorld()) return false;
	if (World->GetWorldSettings()->DefaultGameMode != AUEShedMovementGymGameMode::StaticClass())
	{
		if (bLog) UE_LOG(LogTemp, Error, TEXT("Movement Gym has the wrong game mode"));
		return false;
	}
	int32 TaggedActors = 0;
	int32 Starts = 0;
	int32 Providers = 0;
	for (AActor* Actor : World->PersistentLevel->Actors)
	{
		if (Actor == nullptr || !Actor->ActorHasTag(TEXT("UEShedScenarioFixture"))) continue;
		++TaggedActors;
		if (Actor->IsA<APlayerStart>()) ++Starts;
		if (Actor->IsA<AUEShedMovementGymState>()) ++Providers;
	}
	const bool bValid = TaggedActors == 5 && Starts == 1 && Providers == 1;
	if (bLog && bValid) UE_LOG(LogTemp, Display,
		TEXT("Movement Gym fixture has %d actors, %d starts, and %d providers"),
		TaggedActors, Starts, Providers);
	if (bLog && !bValid) UE_LOG(LogTemp, Error,
		TEXT("Movement Gym fixture has %d actors, %d starts, and %d providers"),
		TaggedActors, Starts, Providers);
	return bValid;
}

bool GenerateMovementGym()
{
	UPackage* Package = FindOrCreatePackage(MovementGymPackageName);
	if (Package == nullptr) return false;
	UWorld* World = UWorld::FindWorldInPackage(Package);
	const bool bCreatedWorld = World == nullptr;
	if (World == nullptr)
	{
		UWorldFactory* Factory = NewObject<UWorldFactory>();
		Factory->WorldType = EWorldType::Editor;
		Factory->bCreateWorldPartition = false;
		World = Cast<UWorld>(Factory->FactoryCreateNew(UWorld::StaticClass(), Package,
			MovementGymAssetName, RF_Public | RF_Standalone, nullptr, GWarn));
	}
	if (World == nullptr || World->IsPartitionedWorld()) return false;
	if (!bCreatedWorld && VerifyMovementGymWorld(World, false))
	{
		UE_LOG(LogTemp, Display, TEXT("Movement Gym fixture already matches its contract"));
		return true;
	}
	TArray<AActor*> Existing;
	for (AActor* Actor : World->PersistentLevel->Actors)
	{
		if (Actor != nullptr && Actor->ActorHasTag(TEXT("UEShedScenarioFixture")))
		{
			Existing.Add(Actor);
		}
	}
	for (AActor* Actor : Existing)
	{
		World->EditorDestroyActor(Actor, true);
	}
	World->GetWorldSettings()->DefaultGameMode = AUEShedMovementGymGameMode::StaticClass();

	auto AddBlock = [&](const TCHAR* Name, const TCHAR* Label, const FVector& Location,
		const FVector& Scale, const FLinearColor& Color) -> AStaticMeshActor*
	{
		FActorSpawnParameters Spawn;
		Spawn.Name = Name;
		Spawn.NameMode = FActorSpawnParameters::ESpawnActorNameMode::Required_ErrorAndReturnNull;
		Spawn.bCreateActorPackage = false;
		AStaticMeshActor* Actor = World->SpawnActor<AStaticMeshActor>(
			Location, FRotator::ZeroRotator, Spawn);
		if (Actor == nullptr) return nullptr;
		Actor->Tags.Add(TEXT("UEShedScenarioFixture"));
		Actor->SetActorLabel(Label);
		Actor->GetStaticMeshComponent()->SetStaticMesh(LoadObject<UStaticMesh>(nullptr,
			TEXT("/Engine/BasicShapes/Cube.Cube")));
		Actor->SetActorScale3D(Scale);
		ApplySolidColor(Actor->GetStaticMeshComponent(), Color);
		return Actor;
	};

	AStaticMeshActor* Floor = AddBlock(TEXT("MovementGymFloor"), TEXT("Movement Gym Floor"),
		FVector(1500, 0, -50), FVector(40, 14, 1),
		FLinearColor(0.12f, 0.16f, 0.22f, 1.0f));
	AStaticMeshActor* NearMarker = AddBlock(TEXT("MovementGymNearMarker"), TEXT("Near Bridge Marker"),
		FVector(750, -500, 75), FVector(0.35f, 0.35f, 1.5f),
		FLinearColor(0.92f, 0.46f, 0.18f, 1.0f));
	AStaticMeshActor* Cache = AddBlock(TEXT("MovementGymCache"), TEXT("Scenario Cache"),
		FVector(1450, 350, 50), FVector(0.8f, 0.8f, 1.0f),
		FLinearColor(0.20f, 0.70f, 0.48f, 1.0f));
	FActorSpawnParameters StartSpawn;
	StartSpawn.Name = TEXT("MovementGymPlayerStart");
	StartSpawn.NameMode = FActorSpawnParameters::ESpawnActorNameMode::Required_ErrorAndReturnNull;
	StartSpawn.bCreateActorPackage = false;
	APlayerStart* Start = World->SpawnActor<APlayerStart>(
		FVector(0, 0, 100), FRotator::ZeroRotator, StartSpawn);
	FActorSpawnParameters StateSpawn;
	StateSpawn.Name = TEXT("MovementGymState");
	StateSpawn.NameMode = FActorSpawnParameters::ESpawnActorNameMode::Required_ErrorAndReturnNull;
	StateSpawn.bCreateActorPackage = false;
	AUEShedMovementGymState* State = World->SpawnActor<AUEShedMovementGymState>(
		FVector(1450, 350, 100), FRotator::ZeroRotator, StateSpawn);
	if (Floor == nullptr || NearMarker == nullptr || Cache == nullptr
		|| Start == nullptr || State == nullptr)
	{
		if (bCreatedWorld) World->CleanupWorld();
		return false;
	}
	Start->Tags.Add(TEXT("UEShedScenarioFixture"));
	Start->PlayerStartTag = TEXT("Scenario");
	Start->SetActorLabel(TEXT("Scenario Player Start"));
	State->Tags.Add(TEXT("UEShedScenarioFixture"));
	State->SetActorLabel(TEXT("Movement Gym State"));

	Package->MarkPackageDirty();
	const bool bSaved = VerifyMovementGymWorld(World, true) && SaveAsset(Package, World);
	if (bCreatedWorld) World->CleanupWorld();
	if (bSaved) UE_LOG(LogTemp, Display, TEXT("Generated %s"), MovementGymPackageName);
	return bSaved;
}

bool VerifyMovementGym()
{
	UPackage* Package = LoadPackage(nullptr, MovementGymPackageName, LOAD_None);
	UWorld* World = Package == nullptr ? nullptr : UWorld::FindWorldInPackage(Package);
	return VerifyMovementGymWorld(World, true);
}
}

UUEShedBuildFixtureCommandlet::UUEShedBuildFixtureCommandlet()
{
	IsClient = false;
	IsEditor = true;
	IsServer = false;
	LogToConsole = true;
}

int32 UUEShedBuildFixtureCommandlet::Main(const FString& Params)
{
	const TArray<FFixtureTableDefinition> Definitions = GetTableDefinitions();
	FString MapHistoryFixtureDirectory;
	if (FParse::Value(*Params, TEXT("MapHistoryFixtureDirectory="), MapHistoryFixtureDirectory))
	{
		return GenerateMapHistoryFixture(MapHistoryFixtureDirectory,
			FParse::Param(*Params, TEXT("OverwriteMapHistoryFixture"))) ? 0 : 1;
	}
	FString ApplyRequestPath;
	FString ApplyOutputPath;
	if (FParse::Value(*Params, TEXT("ApplyRequest="), ApplyRequestPath)
		&& FParse::Value(*Params, TEXT("ApplyOutput="), ApplyOutputPath))
	{
		FString RequestJson;
		if (!FFileHelper::LoadFileToString(
			RequestJson, *FPaths::ConvertRelativePathToFull(ApplyRequestPath))) return 1;
		FString ResultJson;
		UUEShedAuthoringLibrary::Apply(RequestJson, ResultJson);
		bool bSucceeded = FFileHelper::SaveStringToFile(
			ResultJson, *FPaths::ConvertRelativePathToFull(ApplyOutputPath));
		FString SecondApplyRequest;
		FString SecondApplyOutput;
		if (FParse::Value(*Params, TEXT("SecondApplyRequest="), SecondApplyRequest)
			&& FParse::Value(*Params, TEXT("SecondApplyOutput="), SecondApplyOutput))
		{
			FString SecondRequestJson;
			FString SecondResultJson;
			bSucceeded = FFileHelper::LoadFileToString(SecondRequestJson,
				*FPaths::ConvertRelativePathToFull(SecondApplyRequest)) && bSucceeded;
			UUEShedAuthoringLibrary::Apply(SecondRequestJson, SecondResultJson);
			bSucceeded = FFileHelper::SaveStringToFile(SecondResultJson,
				*FPaths::ConvertRelativePathToFull(SecondApplyOutput)) && bSucceeded;
		}
		FString LookupOperation;
		FString LookupOutput;
		if (FParse::Value(*Params, TEXT("LookupOperation="), LookupOperation)
			&& FParse::Value(*Params, TEXT("LookupOutput="), LookupOutput))
		{
			FString LookupJson;
			UUEShedAuthoringLibrary::LookupApplyResult(LookupOperation, LookupJson);
			bSucceeded = FFileHelper::SaveStringToFile(
				LookupJson, *FPaths::ConvertRelativePathToFull(LookupOutput)) && bSucceeded;
		}
		FString SaveAfterApplyRequest;
		FString SaveAfterApplyOutput;
		if (FParse::Value(*Params, TEXT("SaveAfterApplyRequest="), SaveAfterApplyRequest)
			&& FParse::Value(*Params, TEXT("SaveAfterApplyOutput="), SaveAfterApplyOutput))
		{
			FString SaveRequestJson;
			FString SaveResultJson;
			bSucceeded = FFileHelper::LoadFileToString(SaveRequestJson,
				*FPaths::ConvertRelativePathToFull(SaveAfterApplyRequest)) && bSucceeded;
			UUEShedAuthoringLibrary::Save(SaveRequestJson, SaveResultJson);
			bSucceeded = FFileHelper::SaveStringToFile(SaveResultJson,
				*FPaths::ConvertRelativePathToFull(SaveAfterApplyOutput)) && bSucceeded;
		}
		return bSucceeded ? 0 : 1;
	}

	FString SaveRequestPath;
	FString SaveOutputPath;
	if (FParse::Value(*Params, TEXT("SaveRequest="), SaveRequestPath)
		&& FParse::Value(*Params, TEXT("SaveOutput="), SaveOutputPath))
	{
		FString RequestJson;
		if (!FFileHelper::LoadFileToString(
			RequestJson, *FPaths::ConvertRelativePathToFull(SaveRequestPath))) return 1;
		FString ResultJson;
		UUEShedAuthoringLibrary::Save(RequestJson, ResultJson);
		return FFileHelper::SaveStringToFile(
			ResultJson, *FPaths::ConvertRelativePathToFull(SaveOutputPath)) ? 0 : 1;
	}

	FString SnapshotDirectory;
	if (FParse::Value(*Params, TEXT("SnapshotDirectory="), SnapshotDirectory))
	{
		const FString OutputDirectory = FPaths::ConvertRelativePathToFull(SnapshotDirectory);
		IFileManager::Get().MakeDirectory(*OutputDirectory, true);
		bool bSucceeded = true;
		for (const FFixtureTableDefinition& Definition : Definitions)
		{
			FString SnapshotJson;
			UUEShedAuthoringLibrary::GetTableSnapshot(ObjectPath(Definition), SnapshotJson);
			bSucceeded = FFileHelper::SaveStringToFile(
				SnapshotJson, *FPaths::Combine(OutputDirectory,
					FString(Definition.AssetName) + TEXT(".json"))) && bSucceeded;
		}
		FString CompositeJson;
		UUEShedAuthoringLibrary::GetTableSnapshot(
			TEXT("/Game/Fixture/Authoring/CDT_Scalars.CDT_Scalars"), CompositeJson);
		bSucceeded = FFileHelper::SaveStringToFile(
			CompositeJson, *FPaths::Combine(OutputDirectory, TEXT("CDT_Scalars.json")))
			&& bSucceeded;
		return bSucceeded ? 0 : 1;
	}

	if (FParse::Param(*Params, TEXT("BenchmarkLevelParse")))
	{
		return BenchmarkLevelParse() ? 0 : 1;
	}

	FString ConformanceDirectory;
	if (FParse::Value(*Params, TEXT("ConformanceDirectory="), ConformanceDirectory))
	{
		const FString OutputDirectory = FPaths::ConvertRelativePathToFull(ConformanceDirectory);
		IFileManager::Get().MakeDirectory(*OutputDirectory, true);
		return WriteConformanceEvidence(OutputDirectory) ? 0 : 1;
	}

	FString SnapshotTable;
	FString SnapshotOutput;
	if (FParse::Value(*Params, TEXT("SnapshotTable="), SnapshotTable)
		&& FParse::Value(*Params, TEXT("SnapshotOutput="), SnapshotOutput))
	{
		FString SnapshotJson;
		UUEShedAuthoringLibrary::GetTableSnapshot(SnapshotTable, SnapshotJson);
		const FString OutputPath = FPaths::ConvertRelativePathToFull(SnapshotOutput);
		IFileManager::Get().MakeDirectory(*FPaths::GetPath(OutputPath), true);
		return FFileHelper::SaveStringToFile(SnapshotJson, *OutputPath) ? 0 : 1;
	}

	const bool VerifyOnly = FParse::Param(*Params, TEXT("VerifyOnly"));
	if (FParse::Param(*Params, TEXT("ScenarioOnly")))
	{
		return (VerifyOnly ? VerifyMovementGym() : GenerateMovementGym()) ? 0 : 1;
	}

	bool Succeeded = true;
	if (!VerifyOnly)
	{
		for (const FFixtureTableDefinition& Definition : Definitions)
		{
			Succeeded = GenerateTable(Definition) && Succeeded;
		}
		Succeeded = GenerateComposite() && Succeeded;
		Succeeded = GenerateGameTextCorpus() && Succeeded;
		Succeeded = GenerateOfflineWorldMap() && Succeeded;
		Succeeded = GenerateCameraMap() && Succeeded;
		Succeeded = GenerateMapReviewGallery() && Succeeded;
		Succeeded = GenerateAuditTextures() && Succeeded;
		Succeeded = GenerateAnimationFixtures() && Succeeded;
		Succeeded = GenerateLevelSequenceFixture() && Succeeded;
		Succeeded = GenerateNestedLevelSequenceFixture() && Succeeded;
		Succeeded = GenerateEnhancedInputFixtures() && Succeeded;
		Succeeded = GenerateMovementGym() && Succeeded;
	}
	else
	{
		for (const FFixtureTableDefinition& Definition : Definitions)
		{
			Succeeded = VerifyTable(Definition) && Succeeded;
		}
		Succeeded = VerifyComposite() && Succeeded;
		Succeeded = VerifyGameTextCorpus() && Succeeded;
		Succeeded = VerifyOfflineWorldMap() && Succeeded;
		Succeeded = VerifyCameraMap() && Succeeded;
		Succeeded = VerifyMapReviewGallery() && Succeeded;
		Succeeded = VerifyAuditTextures() && Succeeded;
		Succeeded = VerifyAnimationFixtures() && Succeeded;
		Succeeded = VerifyLevelSequenceFixture() && Succeeded;
		Succeeded = VerifyEnhancedInputFixtures() && Succeeded;
		Succeeded = VerifyMovementGym() && Succeeded;
	}

	UE_LOG(LogTemp, Display, TEXT("UE Shed fixture %s %s"),
		VerifyOnly ? TEXT("verification") : TEXT("generation"),
		Succeeded ? TEXT("succeeded") : TEXT("failed"));
	return Succeeded ? 0 : 1;
}
