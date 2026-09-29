#include "UEShedDiscreteSequenceFixture.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Channels/MovieSceneBoolChannel.h"
#include "Channels/MovieSceneByteChannel.h"
#include "Channels/MovieSceneIntegerChannel.h"
#include "Dom/JsonObject.h"
#include "Engine/EngineTypes.h"
#include "LevelSequence.h"
#include "Misc/PackageName.h"
#include "MovieScene.h"
#include "Sections/MovieSceneBoolSection.h"
#include "Channels/MovieSceneChannelProxy.h"
#include "Tracks/MovieSceneBoolTrack.h"
#include "Tracks/MovieSceneByteTrack.h"
#include "Tracks/MovieSceneEnumTrack.h"
#include "Tracks/MovieSceneIntegerTrack.h"
#include "Tracks/MovieSceneVisibilityTrack.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"

namespace
{
const TCHAR* PackageName = TEXT("/Game/Fixture/ParserNative/LS_Discrete");
const TCHAR* ObjectPath = TEXT("/Game/Fixture/ParserNative/LS_Discrete.LS_Discrete");

template<typename TrackType, typename ChannelType>
ChannelType& AddChannel(UMovieScene* Scene, const TCHAR* PropertyName)
{
	auto* Track = Scene->AddTrack<TrackType>();
	Track->SetPropertyNameAndPath(PropertyName, PropertyName);
	auto* Section = Track->CreateNewSection();
	Section->SetRange(TRange<FFrameNumber>(-12, 101));
	Track->AddSection(*Section);
	if (FCString::Strcmp(PropertyName, TEXT("Enabled")) == 0)
		CastChecked<UMovieSceneBoolSection>(Section)->SetIsExternallyInverted(true);
	return *Section->GetChannelProxy().GetChannels<ChannelType>()[0];
}

template<typename ChannelType, typename ValueType>
void Fill(ChannelType& Channel, const TArray<ValueType>& Values, ValueType Default)
{
	Channel.Reset();
	Channel.SetDefault(Default);
	Channel.PreInfinityExtrap = RCCE_Cycle;
	Channel.PostInfinityExtrap = RCCE_Oscillate;
	Channel.AddKeys({FFrameNumber(-12), FFrameNumber(0), FFrameNumber(100)}, Values);
}

TSharedPtr<FJsonValue> JsonValue(bool Value) { return MakeShared<FJsonValueBoolean>(Value); }
TSharedPtr<FJsonValue> JsonValue(int32 Value) { return MakeShared<FJsonValueNumber>(Value); }
TSharedPtr<FJsonValue> JsonValue(uint8 Value) { return MakeShared<FJsonValueNumber>(Value); }

template<typename ChannelType>
TSharedRef<FJsonObject> Evidence(const ChannelType& Channel)
{
	auto Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("has_default"), Channel.GetDefault().IsSet());
	Result->SetField(TEXT("default"), Channel.GetDefault().IsSet()
		? JsonValue(Channel.GetDefault().GetValue()) : MakeShared<FJsonValueNull>());
	Result->SetNumberField(TEXT("pre"), Channel.PreInfinityExtrap);
	Result->SetNumberField(TEXT("post"), Channel.PostInfinityExtrap);
	TArray<TSharedPtr<FJsonValue>> Keys;
	const auto Data = Channel.GetData();
	for (int32 Index = 0; Index < Data.GetTimes().Num(); ++Index)
	{
		auto Key = MakeShared<FJsonObject>();
		Key->SetNumberField(TEXT("frame"), Data.GetTimes()[Index].Value);
		Key->SetField(TEXT("value"), JsonValue(Data.GetValues()[Index]));
		Keys.Add(MakeShared<FJsonValueObject>(Key));
	}
	Result->SetArrayField(TEXT("keys"), Keys);
	return Result;
}
}

bool GenerateDiscreteSequenceFixture()
{
	UPackage* Package = CreatePackage(PackageName);
	Package->FullyLoad();
	if (auto* Existing = FindObject<ULevelSequence>(Package, TEXT("LS_Discrete")))
		Existing->Rename(nullptr, GetTransientPackage(), REN_DontCreateRedirectors | REN_NonTransactional);
	auto* Sequence = NewObject<ULevelSequence>(Package, TEXT("LS_Discrete"), RF_Public | RF_Standalone);
	FAssetRegistryModule::AssetCreated(Sequence);
	Sequence->Initialize();
	auto* Scene = Sequence->GetMovieScene();
	Scene->SetTickResolutionDirectly(FFrameRate(24, 1));
	Scene->SetDisplayRate(FFrameRate(24, 1));
	Scene->SetPlaybackRange(-12, 113);
	Fill(AddChannel<UMovieSceneBoolTrack, FMovieSceneBoolChannel>(Scene, TEXT("Enabled")), TArray<bool>{false, true, false}, true);
	Fill(AddChannel<UMovieSceneVisibilityTrack, FMovieSceneBoolChannel>(Scene, TEXT("bHidden")), TArray<bool>{true, false, true}, false);
	auto& Integers = AddChannel<UMovieSceneIntegerTrack, FMovieSceneIntegerChannel>(Scene, TEXT("Count"));
	Fill(Integers, TArray<int32>{MIN_int32, 0, MAX_int32}, -17);
	Integers.bInterpolateLinearKeys = true;
	Fill(AddChannel<UMovieSceneByteTrack, FMovieSceneByteChannel>(Scene, TEXT("Byte")), TArray<uint8>{0, 127, 255}, uint8(255));
	auto& Enum = AddChannel<UMovieSceneEnumTrack, FMovieSceneByteChannel>(Scene, TEXT("CaptureSource"));
	Fill(Enum, TArray<uint8>{0, 1, 2}, uint8(2));
	Enum.SetEnum(StaticEnum<ESceneCaptureSource>());
	CastChecked<UMovieSceneEnumTrack>(Scene->GetTracks().Last())->SetEnum(StaticEnum<ESceneCaptureSource>());
	auto& DefaultOnly = AddChannel<UMovieSceneBoolTrack, FMovieSceneBoolChannel>(Scene, TEXT("DefaultOnly"));
	DefaultOnly.Reset(); DefaultOnly.SetDefault(true);
	auto& NoDefault = AddChannel<UMovieSceneIntegerTrack, FMovieSceneIntegerChannel>(Scene, TEXT("NoDefault"));
	Fill(NoDefault, TArray<int32>{-1, 0, 1}, int32(0)); NoDefault.RemoveDefault();
	auto& Empty = AddChannel<UMovieSceneByteTrack, FMovieSceneByteChannel>(Scene, TEXT("Empty"));
	Empty.Reset(); Empty.RemoveDefault();
	Sequence->MarkPackageDirty();
	FSavePackageArgs Args;
	Args.TopLevelFlags = RF_Public | RF_Standalone;
	Args.SaveFlags = SAVE_NoError;
	return UPackage::SavePackage(Package, Sequence,
		*FPackageName::LongPackageNameToFilename(PackageName, FPackageName::GetAssetPackageExtension()), Args);
}

TSharedPtr<FJsonObject> DiscreteSequenceFixtureEvidence()
{
	const auto* Sequence = LoadObject<ULevelSequence>(nullptr, ObjectPath);
	if (!Sequence) return nullptr;
	auto Result = MakeShared<FJsonObject>();
	for (const UMovieSceneTrack* Track : Sequence->GetMovieScene()->GetTracks())
	{
		const auto* PropertyTrack = CastChecked<UMovieScenePropertyTrack>(Track);
		for (const UMovieSceneSection* Section : Track->GetAllSections())
		{
			TSharedPtr<FJsonObject> Value;
			const auto& Proxy = Section->GetChannelProxy();
			for (const auto* Channel : Proxy.GetChannels<FMovieSceneBoolChannel>()) Value = Evidence(*Channel);
			for (const auto* Channel : Proxy.GetChannels<FMovieSceneIntegerChannel>())
			{
				Value = Evidence(*Channel);
				Value->SetBoolField(TEXT("interpolate_linear_keys"), Channel->bInterpolateLinearKeys);
			}
			for (const auto* Channel : Proxy.GetChannels<FMovieSceneByteChannel>())
			{
				Value = Evidence(*Channel);
				if (Channel->GetEnum()) Value->SetStringField(TEXT("enum_path"), Channel->GetEnum()->GetPathName());
			}
			if (!Value) return nullptr;
			Value->SetStringField(TEXT("section_class"), Section->GetClass()->GetPathName());
			Result->SetObjectField(PropertyTrack->GetPropertyName().ToString(), Value);
		}
	}
	return Result;
}
