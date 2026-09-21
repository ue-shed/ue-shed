#include "UEShedNativeParserFixture.h"
#include "UEShedNativeParserTypes.h"
#include "Animation/Skeleton.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Curves/CurveFloat.h"
#include "Curves/CurveVector.h"
#include "Curves/CurveLinearColor.h"
#include "Dom/JsonObject.h"
#include "HAL/FileManager.h"
#include "LevelSequence.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "MovieScene.h"
#include "ReferenceSkeleton.h"
#include "Sections/MovieSceneFloatSection.h"
#include "Sections/MovieSceneDoubleSection.h"
#include "Serialization/JsonSerializer.h"
#include "Tracks/MovieSceneFloatTrack.h"
#include "Tracks/MovieSceneDoubleTrack.h"
#include "UObject/MetaData.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"

namespace
{
const FString Root = TEXT("/Game/Fixture/ParserNative/");

template<typename T> T* CreateAsset(const TCHAR* Name)
{
	UPackage* Package = CreatePackage(*(Root + Name));
	Package->FullyLoad();
	T* Asset = FindObject<T>(Package, Name);
	if (Asset)
	{
		Asset->Rename(nullptr, GetTransientPackage(), REN_DontCreateRedirectors | REN_NonTransactional);
		Asset = nullptr;
	}
	if (!Asset)
	{
		Asset = NewObject<T>(Package, Name, RF_Public | RF_Standalone);
		FAssetRegistryModule::AssetCreated(Asset);
	}
	return Asset;
}

template<typename T> T* LoadAsset(const TCHAR* Name)
{
	return LoadObject<T>(nullptr, *(Root + Name + TEXT(".") + Name));
}

bool Save(UObject* Asset)
{
	Asset->MarkPackageDirty();
	const FString Filename = FPackageName::LongPackageNameToFilename(
		Asset->GetOutermost()->GetName(), FPackageName::GetAssetPackageExtension());
	FSavePackageArgs Args;
	Args.TopLevelFlags = RF_Public | RF_Standalone;
	Args.SaveFlags = SAVE_NoError;
	return UPackage::SavePackage(Asset->GetOutermost(), Asset, *Filename, Args);
}

void FillCurve(FRichCurve& Curve, float Offset)
{
	Curve.Reset();
	Curve.DefaultValue = Offset + 0.25f;
	Curve.PreInfinityExtrap = RCCE_Cycle;
	Curve.PostInfinityExtrap = RCCE_Linear;
	Curve.AddKey(-1.f, Offset + 2.f);
	const FKeyHandle Middle = Curve.AddKey(0.5f, Offset - 3.f);
	Curve.AddKey(2.f, Offset + 7.f);
	FRichCurveKey& Key = Curve.GetKey(Middle);
	Key.InterpMode = RCIM_Cubic;
	Key.TangentMode = RCTM_Break;
	Key.TangentWeightMode = RCTWM_WeightedBoth;
	Key.ArriveTangent = 1.25f;
	Key.LeaveTangent = -2.5f;
	Key.ArriveTangentWeight = 0.375f;
	Key.LeaveTangentWeight = 0.75f;
}

template<typename T> void FillChannel(T& Channel)
{
	Channel.Reset();
	Channel.SetTickResolution(FFrameRate(24000, 1001));
	Channel.SetDefault(0.125);
	Channel.PreInfinityExtrap = RCCE_CycleWithOffset;
	Channel.PostInfinityExtrap = RCCE_Oscillate;
	Channel.AddConstantKey(FFrameNumber(-12), 2.5);
	Channel.AddLinearKey(FFrameNumber(18), -4.25);
	FMovieSceneTangentData Tangent;
	Tangent.ArriveTangent = 1.5f;
	Tangent.LeaveTangent = -2.25f;
	Tangent.ArriveTangentWeight = 0.125f;
	Tangent.LeaveTangentWeight = 0.875f;
	Tangent.TangentWeightMode = RCTWM_WeightedBoth;
	Channel.AddCubicKey(FFrameNumber(42), 9.125, RCTM_Break, Tangent);
}

TSharedRef<FJsonObject> CurveEvidence(const FRichCurve& Curve)
{
	auto Result = MakeShared<FJsonObject>();
	Result->SetNumberField(TEXT("default"), Curve.DefaultValue);
	Result->SetNumberField(TEXT("pre"), Curve.PreInfinityExtrap);
	Result->SetNumberField(TEXT("post"), Curve.PostInfinityExtrap);
	TArray<TSharedPtr<FJsonValue>> Keys;
	for (const FRichCurveKey& Key : Curve.GetConstRefOfKeys())
	{
		auto Entry = MakeShared<FJsonObject>();
		Entry->SetNumberField(TEXT("time"), Key.Time);
		Entry->SetNumberField(TEXT("value"), Key.Value);
		Entry->SetNumberField(TEXT("interp"), Key.InterpMode);
		Entry->SetNumberField(TEXT("tangent_mode"), Key.TangentMode);
		Entry->SetNumberField(TEXT("weight_mode"), Key.TangentWeightMode);
		Entry->SetNumberField(TEXT("arrive"), Key.ArriveTangent);
		Entry->SetNumberField(TEXT("leave"), Key.LeaveTangent);
		Entry->SetNumberField(TEXT("arrive_weight"), Key.ArriveTangentWeight);
		Entry->SetNumberField(TEXT("leave_weight"), Key.LeaveTangentWeight);
		Keys.Add(MakeShared<FJsonValueObject>(Entry));
	}
	Result->SetArrayField(TEXT("keys"), Keys);
	return Result;
}

template<typename T> TSharedRef<FJsonObject> ChannelEvidence(const T& Channel)
{
	auto Result = MakeShared<FJsonObject>();
	if (Channel.GetDefault().IsSet()) Result->SetNumberField(TEXT("default"), Channel.GetDefault().GetValue());
	else Result->SetField(TEXT("default"), MakeShared<FJsonValueNull>());
	Result->SetNumberField(TEXT("pre"), Channel.PreInfinityExtrap);
	Result->SetNumberField(TEXT("post"), Channel.PostInfinityExtrap);
	Result->SetNumberField(TEXT("numerator"), Channel.GetTickResolution().Numerator);
	Result->SetNumberField(TEXT("denominator"), Channel.GetTickResolution().Denominator);
	const auto Data = Channel.GetData();
	TArray<TSharedPtr<FJsonValue>> Keys;
	for (int32 Index = 0; Index < Data.GetTimes().Num(); ++Index)
	{
		const auto& Key = Data.GetValues()[Index];
		auto Entry = MakeShared<FJsonObject>();
		Entry->SetNumberField(TEXT("frame"), Data.GetTimes()[Index].Value);
		Entry->SetNumberField(TEXT("value"), Key.Value);
		Entry->SetNumberField(TEXT("interp"), Key.InterpMode);
		Entry->SetNumberField(TEXT("tangent_mode"), Key.TangentMode);
		Entry->SetNumberField(TEXT("weight_mode"), Key.Tangent.TangentWeightMode);
		Entry->SetNumberField(TEXT("arrive"), Key.Tangent.ArriveTangent);
		Entry->SetNumberField(TEXT("leave"), Key.Tangent.LeaveTangent);
		Entry->SetNumberField(TEXT("arrive_weight"), Key.Tangent.ArriveTangentWeight);
		Entry->SetNumberField(TEXT("leave_weight"), Key.Tangent.LeaveTangentWeight);
		Keys.Add(MakeShared<FJsonValueObject>(Entry));
	}
	Result->SetArrayField(TEXT("keys"), Keys);
	return Result;
}

TArray<TSharedPtr<FJsonValue>> Numbers(std::initializer_list<double> Values)
{
	TArray<TSharedPtr<FJsonValue>> Result;
	for (double Value : Values) Result.Add(MakeShared<FJsonValueNumber>(Value));
	return Result;
}
}

bool GenerateNativeParserFixtures()
{
	UCurveFloat* Float = CreateAsset<UCurveFloat>(TEXT("CF_Native"));
	FillCurve(Float->FloatCurve, 0.f);
	UCurveVector* Vector = CreateAsset<UCurveVector>(TEXT("CV_Native"));
	for (int32 Index = 0; Index < 3; ++Index) FillCurve(Vector->FloatCurves[Index], Index * 10.f);
	UCurveLinearColor* Color = CreateAsset<UCurveLinearColor>(TEXT("CC_Native"));
	for (int32 Index = 0; Index < 4; ++Index) FillCurve(Color->FloatCurves[Index], Index * 0.25f);
	if (!Save(Float) || !Save(Vector) || !Save(Color)) return false;

	USkeleton* Skeleton = CreateAsset<USkeleton>(TEXT("SK_Native"));
	if (Skeleton->GetReferenceSkeleton().GetRawBoneNum() == 0)
	{
		FReferenceSkeletonModifier Modifier(Skeleton);
		Modifier.Add(FMeshBoneInfo(TEXT("root"), TEXT("root"), INDEX_NONE),
			FTransform(FQuat::Identity, FVector(1.25, -2.5, 3.75), FVector(1.0, 1.0, 1.0)));
		Modifier.Add(FMeshBoneInfo(TEXT("joint"), TEXT("joint"), 0),
			FTransform(FQuat(FVector::UpVector, PI / 3.0), FVector(10.0, 20.0, 30.0), FVector(0.5, 1.5, 2.0)));
	}
	if (!Save(Skeleton)) return false;

	UUEShedNativeCoverageAsset* Asset = CreateAsset<UUEShedNativeCoverageAsset>(TEXT("DA_Native"));
	FillChannel(Asset->FloatChannel);
	FillChannel(Asset->DoubleChannel);
	Asset->DoubleChannel.AddLinearKey(FFrameNumber(100), 123456789.12345679);
	Asset->EmptyChannel.Reset();
	Asset->EmptyChannel.RemoveDefault();
	Asset->EmptyChannel.SetTickResolution(FFrameRate(30, 1));
	FUEShedNativeInner Inner;
	Inner.Count = -37;
	Inner.Label = TEXT("caf\u00e9 / \u4fdd\u5b58");
	Inner.Offset = FVector(1.25, -2.5, 3.75);
	Inner.Reference = Float;
	Asset->Value.InitializeAs<FUEShedNativeInner>(Inner);
	Asset->EmptyValue.Reset();
	FVector NativeVector(4.5, -6.25, 8.125);
	Asset->NativeValue.InitializeAs(TBaseStructure<FVector>::Get(), reinterpret_cast<const uint8*>(&NativeVector));
	Asset->Values = {Asset->Value, Asset->EmptyValue, Asset->NativeValue};
	const FQuat OpaqueRotation(0.0, 0.0, 0.5, 0.8660254037844386);
	Asset->OpaqueValue.InitializeAs(TBaseStructure<FQuat>::Get(), reinterpret_cast<const uint8*>(&OpaqueRotation));
	FMetaData& Metadata = Asset->GetOutermost()->GetMetaData();
	Metadata.RootMetaDataMap.Add(TEXT("FixturePurpose"), TEXT("Shared native layouts"));
	Metadata.RootMetaDataMap.Add(TEXT("EmptyRoot"), TEXT(""));
	Metadata.SetValue(Asset, TEXT("Comment"), TEXT("caf\u00e9 / \u4fdd\u5b58"));
	Metadata.SetValue(Asset, TEXT("Empty"), TEXT(""));
	if (!Save(Asset)) return false;

	ULevelSequence* Sequence = CreateAsset<ULevelSequence>(TEXT("LS_Numeric"));
	Sequence->Initialize();
	UMovieScene* Scene = Sequence->GetMovieScene();
	Scene->SetTickResolutionDirectly(FFrameRate(24000, 1001));
	Scene->SetPlaybackRange(-12, 112);
	UMovieSceneFloatTrack* FloatTrack = Scene->AddTrack<UMovieSceneFloatTrack>();
	FloatTrack->SetPropertyNameAndPath(TEXT("Intensity"), TEXT("Intensity"));
	auto* FloatSection = CastChecked<UMovieSceneFloatSection>(FloatTrack->CreateNewSection());
	FloatSection->SetRange(TRange<FFrameNumber>(-12, 100));
	FloatTrack->AddSection(*FloatSection);
	FloatSection->GetChannel() = Asset->FloatChannel;
	UMovieSceneDoubleTrack* DoubleTrack = Scene->AddTrack<UMovieSceneDoubleTrack>();
	DoubleTrack->SetPropertyNameAndPath(TEXT("Distance"), TEXT("Distance"));
	auto* DoubleSection = CastChecked<UMovieSceneDoubleSection>(DoubleTrack->CreateNewSection());
	DoubleSection->SetRange(TRange<FFrameNumber>(-12, 101));
	DoubleTrack->AddSection(*DoubleSection);
	DoubleSection->GetChannel() = Asset->DoubleChannel;
	return Save(Sequence);
}

bool WriteNativeParserEvidence(const FString& OutputDirectory)
{
	const auto* Float = LoadAsset<UCurveFloat>(TEXT("CF_Native"));
	const auto* Vector = LoadAsset<UCurveVector>(TEXT("CV_Native"));
	const auto* Color = LoadAsset<UCurveLinearColor>(TEXT("CC_Native"));
	const auto* Skeleton = LoadAsset<USkeleton>(TEXT("SK_Native"));
	const auto* Asset = LoadAsset<UUEShedNativeCoverageAsset>(TEXT("DA_Native"));
	const auto* Sequence = LoadAsset<ULevelSequence>(TEXT("LS_Numeric"));
	if (!Float || !Vector || !Color || !Skeleton || !Asset || !Sequence) return false;
	auto Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("producer"), TEXT("Unreal 5.7 loaded asset APIs"));
	auto Curves = MakeShared<FJsonObject>();
	Curves->SetObjectField(TEXT("float"), CurveEvidence(Float->FloatCurve));
	TArray<TSharedPtr<FJsonValue>> VectorCurves, ColorCurves;
	for (const FRichCurve& Curve : Vector->FloatCurves) VectorCurves.Add(MakeShared<FJsonValueObject>(CurveEvidence(Curve)));
	for (const FRichCurve& Curve : Color->FloatCurves) ColorCurves.Add(MakeShared<FJsonValueObject>(CurveEvidence(Curve)));
	Curves->SetArrayField(TEXT("vector"), VectorCurves);
	Curves->SetArrayField(TEXT("color"), ColorCurves);
	Result->SetObjectField(TEXT("curves"), Curves);
	TArray<TSharedPtr<FJsonValue>> Bones;
	const FReferenceSkeleton& Ref = Skeleton->GetReferenceSkeleton();
	for (int32 Index = 0; Index < Ref.GetRawBoneNum(); ++Index)
	{
		auto Bone = MakeShared<FJsonObject>();
		Bone->SetStringField(TEXT("name"), Ref.GetRawRefBoneInfo()[Index].Name.ToString());
		Bone->SetNumberField(TEXT("parent"), Ref.GetRawRefBoneInfo()[Index].ParentIndex);
		const FTransform& Pose = Ref.GetRawRefBonePose()[Index];
		const FQuat R = Pose.GetRotation(); const FVector T = Pose.GetTranslation(), S = Pose.GetScale3D();
		Bone->SetArrayField(TEXT("rotation"), Numbers({R.X, R.Y, R.Z, R.W}));
		Bone->SetArrayField(TEXT("translation"), Numbers({T.X, T.Y, T.Z}));
		Bone->SetArrayField(TEXT("scale"), Numbers({S.X, S.Y, S.Z}));
		Bones.Add(MakeShared<FJsonValueObject>(Bone));
	}
	Result->SetArrayField(TEXT("bones"), Bones);
	auto NameMap = MakeShared<FJsonObject>();
	for (const auto& Pair : Ref.GetRawNameToIndexMap()) NameMap->SetNumberField(Pair.Key.ToString(), Pair.Value);
	Result->SetObjectField(TEXT("bone_indices"), NameMap);
	Result->SetObjectField(TEXT("float_channel"), ChannelEvidence(Asset->FloatChannel));
	Result->SetObjectField(TEXT("double_channel"), ChannelEvidence(Asset->DoubleChannel));
	Result->SetObjectField(TEXT("empty_channel"), ChannelEvidence(Asset->EmptyChannel));
	auto Instance = MakeShared<FJsonObject>();
	const FUEShedNativeInner& Inner = Asset->Value.Get<FUEShedNativeInner>();
	Instance->SetStringField(TEXT("type"), Asset->Value.GetScriptStruct()->GetPathName());
	Instance->SetNumberField(TEXT("count"), Inner.Count);
	Instance->SetStringField(TEXT("label"), Inner.Label);
	Instance->SetStringField(TEXT("reference"), Inner.Reference->GetPathName());
	Instance->SetArrayField(TEXT("offset"), Numbers({Inner.Offset.X, Inner.Offset.Y, Inner.Offset.Z}));
	Result->SetObjectField(TEXT("instance"), Instance);
	const FVector& NativeVector = *reinterpret_cast<const FVector*>(Asset->NativeValue.GetMemory());
	Result->SetArrayField(TEXT("native_instance"), Numbers({NativeVector.X, NativeVector.Y, NativeVector.Z}));
	Result->SetBoolField(TEXT("empty_instance"), !Asset->EmptyValue.IsValid());
	auto Metadata = MakeShared<FJsonObject>(), Objects = MakeShared<FJsonObject>(), Package = MakeShared<FJsonObject>();
	const FMetaData& Meta = Asset->GetOutermost()->GetMetaData();
	for (const auto& Pair : Meta.RootMetaDataMap) Package->SetStringField(Pair.Key.ToString(), Pair.Value);
	for (const auto& Object : Meta.ObjectMetaDataMap)
	{
		auto Fields = MakeShared<FJsonObject>();
		for (const auto& Pair : Object.Value) Fields->SetStringField(Pair.Key.ToString(), Pair.Value);
		Objects->SetObjectField(Object.Key.ToString(), Fields);
	}
	Metadata->SetObjectField(TEXT("root"), Package); Metadata->SetObjectField(TEXT("objects"), Objects);
	Result->SetObjectField(TEXT("metadata"), Metadata);
	TArray<TSharedPtr<FJsonValue>> SequenceChannels;
	for (UMovieSceneTrack* Track : Sequence->GetMovieScene()->GetTracks())
	{
		for (UMovieSceneSection* Section : Track->GetAllSections())
		{
			if (auto* S = Cast<UMovieSceneFloatSection>(Section)) SequenceChannels.Add(MakeShared<FJsonValueObject>(ChannelEvidence(S->GetChannel())));
			if (auto* S = Cast<UMovieSceneDoubleSection>(Section)) SequenceChannels.Add(MakeShared<FJsonValueObject>(ChannelEvidence(S->GetChannel())));
		}
	}
	Result->SetArrayField(TEXT("sequence_channels"), SequenceChannels);
	FString Json;
	const auto Writer = TJsonWriterFactory<>::Create(&Json);
	if (!FJsonSerializer::Serialize(Result, Writer)) return false;
	IFileManager::Get().MakeDirectory(*OutputDirectory, true);
	return FFileHelper::SaveStringToFile(Json, *FPaths::Combine(OutputDirectory, TEXT("native-coverage.json")), FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
}
